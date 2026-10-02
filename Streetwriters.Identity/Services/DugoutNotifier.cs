/*
This file is part of the Notesnook Sync Server project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the Affero GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
Affero GNU General Public License for more details.

You should have received a copy of the Affero GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

using System;
using System.Linq;
using System.Net.Http;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Logging;
using Streetwriters.Common;
using Streetwriters.Common.Models;

namespace Streetwriters.Identity.Services
{
    /// <summary>
    /// Epigrapho: the news emails are opt-in. Saying yes is a claim on the
    /// account; El Dugout, Azteya's CRM, hears about it (and about a change of
    /// heart, a new email or a deleted account) so campaigns only reach the
    /// people who asked. Nobody who never said yes is ever sent to El Dugout.
    /// </summary>
    public static class MarketingConsent
    {
        // Upstream's claim meant the opposite (it marked an opt-out). It is
        // removed when found and never read, so every account made before this
        // starts at no.
        public static string OptOutClaim(string clientId) => $"{clientId}:marketing_consent";
        public static string OptInClaim(string clientId) => $"{clientId}:marketing_opt_in";
        // Set the first time El Dugout is told about the account.
        public static string SentClaim(string clientId) => $"{clientId}:marketing_sent";

        public static bool Has(System.Collections.Generic.IList<Claim> claims, string type) => claims.Any((claim) => claim.Type == type);

        public static async Task SetAsync(UserManager<User> userManager, User user, string clientId, bool enabled, string? locale)
        {
            var claims = await userManager.GetClaimsAsync(user);
            foreach (var claim in claims.Where((claim) => claim.Type == OptOutClaim(clientId) || claim.Type == OptInClaim(clientId)).ToList())
                await userManager.RemoveClaimAsync(user, claim);
            if (enabled) await userManager.AddClaimAsync(user, new Claim(OptInClaim(clientId), "true"));

            if (!enabled && !Has(claims, SentClaim(clientId))) return;
            if (enabled && !Has(claims, SentClaim(clientId)))
                await userManager.AddClaimAsync(user, new Claim(SentClaim(clientId), "true"));
            DugoutNotifier.Enqueue(new DugoutEvent("consent", user.Email!, null, locale, user.Id.CreationTime, enabled));
        }

        public static async Task EmailChangedAsync(UserManager<User> userManager, User user, string clientId, string previousEmail)
        {
            var claims = await userManager.GetClaimsAsync(user);
            if (!Has(claims, SentClaim(clientId))) return;
            DugoutNotifier.Enqueue(new DugoutEvent("email_changed", user.Email!, previousEmail, null, user.Id.CreationTime, Has(claims, OptInClaim(clientId))));
        }

        public static async Task DeletedAsync(UserManager<User> userManager, User user, string clientId)
        {
            var claims = await userManager.GetClaimsAsync(user);
            if (!Has(claims, SentClaim(clientId))) return;
            DugoutNotifier.Enqueue(new DugoutEvent("deleted", user.Email!, null, null, user.Id.CreationTime, false));
        }
    }

    public record DugoutEvent(string Event, string Email, string? PreviousEmail, string? Locale, DateTime SignupDate, bool Consent);

    public static class DugoutNotifier
    {
        static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
        static readonly Channel<(DugoutEvent Event, DateTime QueuedAt)> queue = Channel.CreateUnbounded<(DugoutEvent, DateTime)>();
        public static TimeSpan GiveUpAfter = TimeSpan.FromHours(1);
        public static TimeSpan FirstRetry = TimeSpan.FromSeconds(30);
        static ILogger? logger;

        static string? Url => Constants.ReadSecret("EPIGRAPHO_DUGOUT_URL")?.Trim();
        static string? Secret => Constants.ReadSecret("EPIGRAPHO_DUGOUT_SECRET")?.Trim();
        static bool IsConfigured => !string.IsNullOrEmpty(Url) && !string.IsNullOrEmpty(Secret);

        public static void Start(ILogger log)
        {
            logger = log;
            if (!IsConfigured)
            {
                log.LogInformation("El Dugout is not configured (EPIGRAPHO_DUGOUT_URL, EPIGRAPHO_DUGOUT_SECRET); news email consent stays on this server.");
                return;
            }
            _ = Task.Run(RunAsync);
        }

        public static void Enqueue(DugoutEvent ev)
        {
            if (IsConfigured) queue.Writer.TryWrite((ev, DateTime.UtcNow));
        }

        public static string Sign(string body, string secret) =>
            Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant();

        // ponytail: one in-memory queue, sent one at a time so a person's
        // changes reach El Dugout in order. A restart drops what is still
        // pending; a stored outbox if that ever matters.
        static async Task RunAsync()
        {
            await foreach (var (ev, queuedAt) in queue.Reader.ReadAllAsync())
            {
                var delay = FirstRetry;
                while (true)
                {
                    try
                    {
                        if (await SendAsync(ev)) break;
                    }
                    catch (Exception ex)
                    {
                        logger?.LogWarning("El Dugout: {Event} for @{Domain} failed: {Error}", ev.Event, Domain(ev.Email), ex.Message);
                    }
                    if (DateTime.UtcNow - queuedAt + delay > GiveUpAfter)
                    {
                        logger?.LogError("El Dugout: gave up on {Event} for @{Domain}", ev.Event, Domain(ev.Email));
                        break;
                    }
                    await Task.Delay(delay);
                    delay *= 2;
                }
            }
        }

        static async Task<bool> SendAsync(DugoutEvent ev)
        {
            // Signed again on every try: El Dugout turns away anything older
            // than ten minutes.
            var body = JsonSerializer.Serialize(new
            {
                @event = ev.Event,
                email = ev.Email,
                previousEmail = ev.PreviousEmail,
                locale = ev.Locale,
                signupDate = ev.SignupDate.ToString("yyyy-MM-dd"),
                consent = ev.Consent,
                ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            });
            using var request = new HttpRequestMessage(HttpMethod.Post, Url)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            };
            request.Headers.Add("X-Epigrapho-Signature", Sign(body, Secret!));
            using var response = await http.SendAsync(request);
            if (response.IsSuccessStatusCode)
            {
                logger?.LogInformation("El Dugout: {Event} for @{Domain} sent", ev.Event, Domain(ev.Email));
                return true;
            }
            logger?.LogWarning("El Dugout: {Event} for @{Domain} answered {Status}", ev.Event, Domain(ev.Email), (int)response.StatusCode);
            return false;
        }

        static string Domain(string email) => email[(email.IndexOf('@') + 1)..];
    }
}
