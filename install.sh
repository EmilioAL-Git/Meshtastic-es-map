#!/bin/bash
##
## install.sh — Instala meshtastic-es-map en el VPS
## Ejecutar como root o con sudo
##
## Uso: sudo bash install.sh
##

set -euo pipefail

INSTALL_DIR="/opt/meshtastic-es-map"
DATA_DIR="$INSTALL_DIR/data"
SERVICE_USER="www-data"   # o el usuario que prefieras

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }

# ─── 1. Dependencias del sistema ──────────────────────────────────────────────
info "Actualizando paquetes e instalando dependencias…"
apt-get update -qq
apt-get install -y python3 python3-venv python3-pip nginx curl

# ─── 2. Estructura de directorios ─────────────────────────────────────────────
info "Creando estructura en $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"/{collector,web/data}
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

# ─── 3. Copiar archivos (asume que estás en el repo) ──────────────────────────
info "Copiando archivos…"
cp collector/collector.py "$INSTALL_DIR/collector/"
cp web/index.html         "$INSTALL_DIR/web/"
cp web/style.css          "$INSTALL_DIR/web/"
cp web/favicon.svg        "$INSTALL_DIR/web/"
mkdir -p "$INSTALL_DIR/web/js"
cp web/js/*.js            "$INSTALL_DIR/web/js/"

# ─── 4. Entorno Python virtual ────────────────────────────────────────────────
info "Creando entorno virtual Python…"
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip

info "Entorno virtual listo (el collector solo usa stdlib)"

# ─── 5. Servicios systemd ─────────────────────────────────────────────────────
info "Instalando servicios systemd…"
cp meshtastic-es-map-collector.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable meshtastic-es-map-collector
systemctl start  meshtastic-es-map-collector

# ─── 6. Primera colección (para que la BD tenga datos antes de abrir Nginx) ──
info "Ejecutando primera colección de datos (puede tardar 10-20 seg)…"
sleep 5
"$INSTALL_DIR/venv/bin/python" "$INSTALL_DIR/collector/collector.py" \
    --db "$INSTALL_DIR/data/meshtastic-es-map.db" || warn "Primera colección falló (la API puede no estar disponible)"

# ─── 7. Nginx ─────────────────────────────────────────────────────────────────
info "Configurando Nginx…"
cp nginx-meshtastic-es-map.conf /etc/nginx/sites-available/meshtastic-es-map

if [ ! -L /etc/nginx/sites-enabled/meshtastic-es-map ]; then
  ln -s /etc/nginx/sites-available/meshtastic-es-map /etc/nginx/sites-enabled/
fi

# Desactivar default si existe
if [ -L /etc/nginx/sites-enabled/default ]; then
  warn "Desactivando site 'default' de Nginx"
  rm /etc/nginx/sites-enabled/default
fi

nginx -t && systemctl reload nginx

# ─── 8. Estado final ──────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Meshtastic-es-map instalado correctamente${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo "  Edita el server_name en /etc/nginx/sites-available/meshtastic-es-map"
echo "  y recarga Nginx: sudo systemctl reload nginx"
echo ""
echo "  Estado de servicios:"
systemctl is-active meshtastic-es-map-collector && echo "  ✓ collector activo" || echo "  ✗ collector INACTIVO"
echo ""
echo "  Logs: journalctl -u meshtastic-es-map-collector -f"
echo "  BD: $DATA_DIR/meshtastic-es-map.db"
