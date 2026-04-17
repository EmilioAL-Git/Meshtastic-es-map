# Meshtastic-es-map — Monitor visual de la red Meshtastic España

Lee la API de meshview, guarda histórico en SQLite y pinta los nodos en un mapa web interactivo.

```
meshview.meshtastic.es  ──►  collector.py  ──►  SQLite + JSON estático
                                                        │
                                               Nginx ──►  index.html (mapa Leaflet)
```

---

## Características

- Mapa interactivo con nodos y conexiones en tiempo real
- Filtros por tipo de nodo: gateway, activo, reciente, sin actividad
- Buscador de nodos con autocompletado
- Panel de detalle por nodo (hardware, rol, canal, batería, conexiones...)
- Diseño responsive — funciona en móvil y escritorio
- Conexiones visibles al seleccionar un nodo
- Modo embed — oculta la barra superior al incrustar en iframe
- Leyenda y estadísticas en cabecera

---

## Estructura

```
meshtastic-es-map/
├── collector/
│   └── collector.py        # Lee API meshview → SQLite + genera JSON
├── web/
│   ├── index.html          # Mapa Leaflet
│   ├── style.css           # Estilos
│   └── data/               # (generado) nodes.json, edges.json, stats.json
├── docker-compose.yml
├── Dockerfile.collector
├── nginx-docker.conf       # Config nginx del contenedor web
├── nginx-meshtastic-es-map.conf  # Config nginx para despliegue directo
├── .env.example
└── README.md
```

---

## Despliegue con Docker (recomendado)

### 1. Clonar y configurar

```bash
git clone https://github.com/EmilioAL-Git/Meshtastic-es-map.git
cd Meshtastic-es-map
cp .env.example .env
# Editar .env si es necesario (puertos, rutas)
```

### 2. Levantar

```bash
docker compose up -d
```

Esto arranca dos contenedores:
- **collector**: recoge datos de meshview cada 5 minutos y genera los JSON
- **web**: nginx que sirve el mapa estático en el puerto configurado (`WEB_PORT`, por defecto 8095)

### 3. Primera colección inmediata

```bash
docker compose exec collector python collector.py
```

### 4. Nginx externo (proxy)

Si sirves el mapa bajo un subpath (ej. `/map`), añade a tu nginx:

```nginx
location = /map {
    return 301 /map/;
}
location /map/ {
    proxy_pass http://localhost:8095/;
}
```

### Comandos útiles

```bash
# Ver estado
docker compose ps

# Ver logs del collector
docker compose logs -f collector

# Actualizar a la última versión
git pull && docker compose restart web

# Reconstruir collector (si cambia collector.py o Dockerfile)
git pull && docker compose build collector && docker compose up -d collector
```

---

## Despliegue sin Docker

### 1. Arrancar el collector

```bash
python3 collector/collector.py --daemon
```

Genera los JSON en `web/data/` cada 5 minutos.

### 2. Arrancar el servidor web

```bash
python3 -m http.server 8095 --directory web/
```

El mapa queda disponible en `http://localhost:8095`.

---

## Variables de entorno (.env)

| Variable | Default | Descripción |
|---|---|---|
| `MESHVIEW_URL` | `https://meshview.meshtastic.es` | URL de la instancia de meshview |
| `WEB_PORT` | `8095` | Puerto del servidor web |
| `COLLECTOR_INTERVAL` | `5` | Minutos entre colecciones |
| `NODE_RETENTION_DAYS` | `7` | Días que se conservan nodos/edges en la BD |
| `DB_PATH` | `/data/meshtastic-es-map.db` | Ruta de la base de datos |
| `JSON_OUT` | `/data/json` | Directorio de salida de los JSON |
| `MAP_AUTO_FIT` | `true` | Ajusta el mapa automáticamente a los nodos al cargar |
| `MAP_LAT` | `40.2` | Latitud inicial (si `MAP_AUTO_FIT=false`) |
| `MAP_LNG` | `-3.7` | Longitud inicial (si `MAP_AUTO_FIT=false`) |
| `MAP_ZOOM` | `8` | Zoom inicial (si `MAP_AUTO_FIT=false`) |

---

## Incrustar en iframe

El mapa detecta automáticamente cuando está dentro de un `<iframe>` y oculta la barra superior, mostrando solo el mapa con un buscador flotante en la esquina superior derecha.

```html
<iframe src="https://tu-dominio.com/map/" width="100%" height="500" frameborder="0"></iframe>
```

También puedes forzarlo con el parámetro `?embed`:

```html
<iframe src="https://tu-dominio.com/map/?embed" width="100%" height="500" frameborder="0"></iframe>
```

---

## Uso del collector

```bash
# Una sola colección (debug)
python3 collector/collector.py

# Modo daemon con intervalo personalizado
python3 collector/collector.py --daemon --interval 10
```

---

## Ajustar fuente de datos

En `collector/collector.py`:

```python
MESHVIEW_BASE = "https://meshview.meshtastic.es"
```

---

## Cómo se obtienen y procesan los datos de meshview

### Endpoints consultados

El collector hace dos peticiones HTTP en cada ciclo:

| Endpoint | Contenido |
|---|---|
| `GET /api/nodes` | Lista de todos los nodos conocidos por meshview |
| `GET /api/edges` | Conexiones entre nodos (vecinos y traceroutes) |

Ambas peticiones incluyen `User-Agent: meshtastic-es-map-collector/1.0` y `Accept: application/json`.

### Campos de nodos usados

La respuesta viene como `{"nodes": [...]}`. De cada nodo se extraen:

| Campo meshview | Campo interno | Notas |
|---|---|---|
| `id` / `node_id` / `num` | `node_id` | Se normaliza a formato `!hexvalue` (ej. `!41ef8236`) |
| `short_name` / `shortName` | `short_name` | |
| `long_name` / `longName` | `long_name` | |
| `hw_model` / `hardware` | `hardware` | Modelo de dispositivo (ej. `HELTEC_V3`) |
| `role` | `role` | `CLIENT`, `ROUTER`, `ROUTER_CLIENT`… |
| `last_lat` / `latitude` | `latitude` | Entero ×1e7 → se divide entre 10.000.000 |
| `last_long` / `longitude` | `longitude` | Ídem |
| `altitude` / `last_alt` | `altitude` | |
| `battery_level` / `device_metrics.battery_level` | `battery_level` | % |
| `voltage` / `device_metrics.voltage` | `voltage` | V |
| `channel_utilization` / `device_metrics.channel_utilization` | `channel_util` | % |
| `air_util_tx` / `device_metrics.air_util_tx` | `air_util_tx` | % |
| `snr` | `snr` | dB |
| `rssi` | `rssi` | dBm |
| `firmware` / `firmware_version` | `firmware` | |
| `channel` | `channel` | Nombre del canal (ej. `MediumFast`) |
| `is_mqtt_gateway` | `is_mqtt_gateway` | Booleano → 0/1 |
| `hops_away` | `hops_away` | Saltos hasta el gateway |
| `last_seen_us` / `last_seen` | `last_seen` | Microsegundos o segundos → se normaliza a unix seconds |
| `first_seen_us` / `first_seen` | `first_seen` | Ídem |

> **Coordenadas:** meshview devuelve latitud y longitud como enteros ×10⁷ (ej. `415422579` → `41.5422579`). El collector detecta esto automáticamente: si el valor absoluto es mayor que 180 lo divide entre 10.000.000.

> **Timestamps:** pueden venir en microsegundos (>32503680000), milisegundos (>9999999999) o segundos. El collector normaliza automáticamente a unix seconds.

### Campos de edges usados

| Campo meshview | Campo interno | Notas |
|---|---|---|
| `from` / `from_node` / `source` | `from_node` | Normalizado a `!hexvalue` |
| `to` / `to_node` / `target` | `to_node` | Ídem |
| `snr` | `snr` | dB del enlace |
| `type` / `edge_type` | `edge_type` | `neighbor` o `traceroute` |
| `last_seen_us` / `last_seen` | `last_seen` | Normalizado a unix seconds |

### Qué se guarda y qué se descarta

- Solo se exportan al frontend los nodos vistos en las **últimas 24 horas**.
- Solo se exportan las conexiones (edges) donde **ambos nodos tienen coordenadas GPS**.
- Los campos `null` en una actualización **no sobreescriben** valores previos (se usa `COALESCE` en el upsert), preservando el historial.

### JSON generados para el frontend

| Archivo | Contenido |
|---|---|
| `data/nodes.json` | Nodos activos últimas 24h con campo `last_seen_ago_min` e `is_recent` calculados |
| `data/edges.json` | Conexiones con coordenadas y nombres de origen/destino resueltos |
| `data/stats.json` | Totales: nodos, activos 1h/24h, gateways, conexiones, timestamp |
| `data/config.json` | Configuración de vista inicial del mapa (zoom, lat, lng) |

---

## Requisitos

- Docker + Docker Compose (despliegue recomendado)
- O Python 3.10+ sin Docker
- Acceso a internet para llegar a meshview.meshtastic.es
