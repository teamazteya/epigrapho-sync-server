# Operación del servidor de sync de Epigrapho

Este manual es para quien opera el servidor, sin depender de nadie más. El servidor corre en una VM de Oracle Cloud (Always Free), en `/opt/epigrapho`, con Docker Compose. Los archivos de esa carpeta salen de `deploy/` en este repo, más tres que solo existen en la VM y nunca van al repo: `.env`, `garage.toml` y `dp-keys/`.

| Dato | Valor |
|---|---|
| VM | `epigrapho-sync`, Ampere A1, 1 OCPU, 3 GB, Ubuntu 24.04, región `mx-queretaro-1` |
| IP pública | `163.192.144.182` |
| Dominios (DNS en Hostinger) | `sync.`, `auth.`, `events.` y `files.azteya.tech` → la IP |
| Llave SSH | `~/.ssh/epigrapho_sync` (usuario `ubuntu`) |
| Respaldos | Bucket `epigrapho-backups`, namespace `axn84pxet3pa`, todas las noches a las 03:00 (hora de México) |
| Imágenes | `ghcr.io/teamazteya/epigrapho-{sync,identity,sse}`, con el tag de `EPIGRAPHO_TAG` en `.env` |

## Entrar

En Windows (PowerShell o Windows Terminal):

```
ssh -i $HOME\.ssh\epigrapho_sync ubuntu@163.192.144.182
cd /opt/epigrapho
```

## Ver el estado

```
sudo docker compose ps                         # todos "Up"; los que tienen chequeo, "(healthy)"
curl -s https://sync.azteya.tech/version       # {"instance":"Epigrapho"}
sudo docker compose logs --tail 50 identity-server
free -m                                        # memoria (ver "Oracle y la memoria")
df -h /                                        # disco
```

Los servicios:
- `notesnook-db`: MongoDB.
- `notesnook-s3`: Garage, donde viven los adjuntos.
- `identity-server`: cuentas y correos.
- `notesnook-server`: el sync.
- `sse-server`: los avisos en vivo.
- `caddy`: HTTPS.
- `autoheal`: reinicia el contenedor que se quede *unhealthy*.

Los logs rotan solos: cada servicio guarda como máximo 3 archivos de 10 MB (`x-logging` en `docker-compose.yml`). Incluyen direcciones IP, y `PRIVACY.md` de la app promete que no se acumulan.

## Reiniciar

```
sudo docker compose restart                    # todo
sudo docker compose restart identity-server    # uno
```

Si la VM se reinicia, todo vuelve solo (`restart: unless-stopped`).

## Actualizar a una versión nueva del servidor

1. En el repo, trae la versión de upstream (`git fetch upstream --tags`), haz merge en `epigrapho` y compílala (`dotnet build`).
2. Crea el tag `v<tag-upstream>-ep.<n>` y súbelo. GitHub Actions publica las imágenes; espera a que el workflow termine en verde.
3. En la VM:
   - edita `.env` y cambia `EPIGRAPHO_TAG`;
   - corre `sudo docker compose pull && sudo docker compose up -d`.
4. Comprueba con `docker compose ps` y `curl …/version`.
5. Si algo falla, vuelve a poner el tag anterior en `.env` y repite `up -d`.

Si cambias `docker-compose.yml` o `Caddyfile` en `deploy/`, cópialos a la VM con `scp` antes del `up -d`.

## Respaldos

- **Cuándo:** el timer `epigrapho-backup.timer` corre `backup.sh` a las 09:00 UTC.
- **Qué sube a `epigrapho-backups`:**
  - `daily/<fecha>/mongo.archive.gz`: las bases `identity` y `notesnook`;
  - `daily/<fecha>/config.tar.gz`: `.env`, `garage.toml`, `dp-keys`, el compose y el Caddyfile;
  - `weekly/<fecha>/`: la copia del domingo;
  - `attachments/`: espejo de los adjuntos.
- **Cuánto guarda:** 7 diarios y 4 semanales.
- **Si falla:** llega un correo a `BACKUP_ALERT_EMAIL`.

```
systemctl list-timers epigrapho-backup.timer   # próxima corrida
sudo systemctl start epigrapho-backup          # correrlo ahora
sudo journalctl -u epigrapho-backup -n 50      # qué pasó
```

El `config.tar.gz` contiene secretos (SMTP, llaves). El bucket es privado: no lo hagas público.

## Restaurar

### En la misma VM (se perdió la base de datos)

1. Baja el respaldo del día: Oracle Console → Buckets → `epigrapho-backups` → `daily/<fecha>`.
2. Cópialo a la VM con `scp` y restaura:

```
sudo docker compose stop identity-server notesnook-server sse-server
sudo docker compose exec -T notesnook-db mongorestore --archive --gzip --drop < mongo.archive.gz
sudo docker compose start identity-server notesnook-server sse-server
```

`--drop` reemplaza las colecciones que existan. Los datos posteriores al respaldo se pierden.

### En una VM nueva (Oracle reclamó o borró la VM)

1. Crea la VM igual que antes: A1 Flex de 1 OCPU y 3 GB, Ubuntu 24.04, con los puertos 80 y 443 abiertos en la security list y en `iptables`. Instala Docker. Pasos en `Epigrapho_S1_Agent_Runbook.md`, Fases 0 y 2.1.
2. Crea `/opt/epigrapho`, copia ahí `deploy/` y descomprime el último `config.tar.gz`. Eso trae `.env`, `garage.toml` y `dp-keys`.
3. `sudo docker compose up -d notesnook-db notesnook-s3`, y luego `sudo ./init-garage.sh`.
4. Restaura MongoDB como arriba.
5. Copia los adjuntos de vuelta a Garage. En una línea:

   ```
   sudo docker run --rm --network epigrapho_epigrapho <las mismas -e RCLONE_CONFIG_* de backup.sh> rclone/rclone:1.71.1 sync oci:epigrapho-backups/attachments garage:attachments
   ```

6. `sudo docker compose up -d`.
7. En Hostinger, apunta los cuatro registros A a la IP nueva. La app no cambia, porque apunta a los dominios.

## Oracle y la memoria

Oracle puede reclamar una VM gratis que pase 7 días con CPU, red **y** memoria por debajo del 20 %. Por eso la VM tiene 3 GB: el servidor ocupa unos 750 MB (~25 %).

- Si `free -m` muestra "used" por debajo de 600 MB durante días, no generes carga artificial: baja la memoria de la VM (Edit shape).
- Si Oracle avisa que la VM está inactiva, o desaparece, sigue "En una VM nueva".

## Disco y quién ocupa más

```
df -h /
sudo docker compose exec -T notesnook-s3 /garage bucket info attachments      # total de adjuntos
```

Cada persona puede guardar hasta `EPIGRAPHO_STORAGE_LIMIT_MB` (500) de adjuntos. Para cambiar el tope, edita `.env` y corre `sudo docker compose up -d notesnook-server`.

## Correos de novedades (El Dugout)

Los correos de novedades son de alta: solo cuenta como "sí" quien lo marcó en la app. El servidor de identidad avisa a El Dugout cada vez que alguien acepta, se da de baja, cambia de correo o borra su cuenta, pero solo si esa persona aceptó alguna vez. El código está en `Streetwriters.Identity/Services/DugoutNotifier.cs`.

En `.env`:

- `EPIGRAPHO_DUGOUT_URL`: la URL de `crm_epigrapho_consent.php` en El Dugout.
- `EPIGRAPHO_DUGOUT_SECRET`: el secreto compartido. Es el mismo que `EPIGRAPHO_CONSENT_SECRET` en el `config.php` de El Dugout. Para generarlo: `openssl rand -hex 32`.

Sin esas dos, el servidor no avisa a nadie y lo dice una vez en el registro al arrancar. Si El Dugout no responde, reintenta durante una hora y deja cada fallo en el registro de `identity-server` (sin el correo completo, solo el dominio): `sudo docker compose logs identity-server | grep "El Dugout"`. Lo pendiente se pierde si el servidor se reinicia en esa hora.

Para probarlo en local: `node deploy/marketing-consent-check.mjs` (la cabecera dice qué necesita).

## Secretos

Viven solo en `/opt/epigrapho/.env` (permisos 600) y en el respaldo. Para cambiar uno (por ejemplo, rotar la SMTP key de Brevo o la llave del Object Storage):

1. `nano .env` y cambia el valor.
2. `sudo docker compose up -d`; recrea solo lo que cambió.
3. Borra la llave vieja en Brevo u Oracle.
