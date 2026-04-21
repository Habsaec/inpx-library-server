#!/usr/bin/env bash
set -euo pipefail

# ── INPX Library Server - install script ─────────────────────────────
# Supported: Debian 11+/12+, Ubuntu 20.04+, Raspbian, OpenMediaVault 6/7/8
#            macOS 13+ (Apple Silicon и Intel), Homebrew или Node с nodejs.org
# Usage:     chmod +x install.sh && sudo ./install.sh
# ─────────────────────────────────────────────────────────────────────

REQUIRED_NODE_MAJOR=18
INSTALL_NODE_MAJOR=20
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="inpx-library"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
if [ -z "$SERVICE_USER" ] || [ "$SERVICE_USER" = "root" ]; then
  SERVICE_USER="$(logname 2>/dev/null || echo '')"
fi

# ── Colors ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "\n${BOLD}── $* ──${NC}"; }

# ── Root check ───────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  err "Этот скрипт нужно запускать с sudo:"
  err "  sudo ./install.sh"
  exit 1
fi

KERNEL="$(uname -s)"

# ── macOS ────────────────────────────────────────────────────────────

install_macos() {
  # Частые пути к brew/node на Apple Silicon и Intel
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

  step "Определение системы"
  DISTRO_NAME="macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"
  info "Система: ${DISTRO_NAME}"
  info "Архитектура: $(uname -m)"

  step "Xcode Command Line Tools"
  if xcode-select -p &>/dev/null; then
    ok "Command Line Tools установлены."
  else
    err "Нужны Xcode Command Line Tools (для сборки нативных модулей Node.js)."
    err "Выполните в терминале (без sudo):  xcode-select --install"
    err "После установки снова:  sudo ./install.sh"
    exit 1
  fi

  resolve_brew() {
    if [ -x /opt/homebrew/bin/brew ]; then echo /opt/homebrew/bin/brew; return; fi
    if [ -x /usr/local/bin/brew ]; then echo /usr/local/bin/brew; return; fi
    command -v brew 2>/dev/null || true
  }

  install_node_via_brew() {
    local brew_bin
    brew_bin=$(resolve_brew)
    if [ -z "$brew_bin" ] && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != "root" ]; then
      brew_bin=$(sudo -u "$SERVICE_USER" bash -lc 'command -v brew' 2>/dev/null) || true
    fi
    if [ -z "$brew_bin" ]; then
      return 1
    fi
    info "Установка Node через Homebrew: $brew_bin"
    if [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != "root" ]; then
      sudo -u "$SERVICE_USER" "$brew_bin" install node
    else
      "$brew_bin" install node
    fi
    return 0
  }

  step "Node.js"

  if has_cmd node; then
    NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge "$REQUIRED_NODE_MAJOR" ]; then
      ok "Node.js $(node -v) — OK (>= ${REQUIRED_NODE_MAJOR})."
    else
      warn "Node.js $(node -v) слишком старый (нужен >= ${REQUIRED_NODE_MAJOR})."
      if ! install_node_via_brew; then
        err "Обновите Node.js: https://nodejs.org (LTS) или установите Homebrew: https://brew.sh"
        exit 1
      fi
    fi
  else
    warn "Node.js не найден в PATH."
    if ! install_node_via_brew; then
      err "Установите Node.js ${REQUIRED_NODE_MAJOR}+: https://nodejs.org (LTS .pkg) или Homebrew (brew install node)."
      err "Затем снова: sudo ./install.sh"
      exit 1
    fi
  fi

  hash -r 2>/dev/null || true
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  if ! has_cmd node; then
    err "Node установлен, но не найден в PATH. Откройте новый терминал или добавьте в PATH: /opt/homebrew/bin"
    exit 1
  fi
  NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt "$REQUIRED_NODE_MAJOR" ]; then
    err "Нужен Node >= ${REQUIRED_NODE_MAJOR}, сейчас: $(node -v)"
    exit 1
  fi

  if ! has_cmd npm; then
    err "npm не найден рядом с node."
    exit 1
  fi
  info "npm $(npm -v)"

  step "Зависимости приложения"
  cd "$APP_DIR"
  info "Рабочая директория: $APP_DIR"
  info "Запуск npm install..."
  if [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != "root" ]; then
    su - "$SERVICE_USER" -c "cd '$APP_DIR' && npm install --omit=dev"
  else
    warn "SERVICE_USER не определён — npm install от root."
    npm install --omit=dev
  fi
  ok "Node-модули установлены."

  step "Директория данных"
  mkdir -p "$APP_DIR/data"
  ok "data/ готова."

  step "FB2-конвертер (опционально)"
  if [ -x "$APP_DIR/converter/fbc" ]; then
    ok "Конвертер fbc уже установлен."
  else
    FB2CNG_VERSION="v1.1.8"
    ARCH="$(uname -m)"
    case "$ARCH" in
      arm64)           FB2CNG_ZIP="fbc-darwin-arm64.zip" ;;
      x86_64)          FB2CNG_ZIP="fbc-darwin-amd64.zip" ;;
      *)               FB2CNG_ZIP="" ;;
    esac
    if [ -n "$FB2CNG_ZIP" ]; then
      info "Скачивание fb2cng ${FB2CNG_VERSION} (${FB2CNG_ZIP})..."
      mkdir -p "$APP_DIR/converter"
      TMPZIP=$(mktemp /tmp/fbc-XXXXXX.zip)
      if curl -fsSL "https://github.com/rupor-github/fb2cng/releases/download/${FB2CNG_VERSION}/${FB2CNG_ZIP}" -o "$TMPZIP"; then
        unzip -qo "$TMPZIP" -d "$APP_DIR/converter"
        chmod +x "$APP_DIR/converter/fbc"
        rm -f "$TMPZIP"
        ok "Конвертер fbc установлен."
      else
        warn "Не удалось скачать fb2cng — конвертация FB2→EPUB может быть недоступна."
        rm -f "$TMPZIP"
      fi
    else
      warn "Архитектура ${ARCH} — готового fbc для macOS нет в релизе."
    fi
  fi

  step "Автозапуск"
  warn "В macOS нет systemd. Автозапуск можно настроить через launchd вручную или использовать ./start.sh после входа."

  step "Права доступа"
  if [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != "root" ]; then
    info "Установка прав для $SERVICE_USER..."
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"
    ok "Права на $APP_DIR установлены."
  else
    warn "SERVICE_USER не определён — chown пропущен."
  fi

  step "Готово!"
  echo ""
  ok "INPX Library Server установлен (macOS)."
  echo ""
  info "Что дальше:"
  info "  1. Запуск:  cd ${APP_DIR} && ./start.sh"
  info "     (или от пользователя с правами: node src/server-entry.js)"
  MAC_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  if [ -n "$MAC_IP" ]; then
    info "  2. Браузер: http://${MAC_IP}:3000  или  http://localhost:3000"
  else
    info "  2. Браузер: http://localhost:3000"
  fi
  info "  3. Вход: admin / admin"
  info "  4. Путь к библиотеке и .inpx — в админ-панели"
  echo ""
}

if [ "$KERNEL" = "Darwin" ]; then
  install_macos
  exit 0
fi

# ── Detect OS (Linux) ─────────────────────────────────────────────────

step "Определение системы"

if [ ! -f /etc/os-release ]; then
  err "Не удалось определить ОС (/etc/os-release отсутствует). Для macOS используйте этот скрипт на Mac; для BSD/WSL см. Docker или ручную установку Node.js."
  exit 1
fi

. /etc/os-release

DISTRO_ID="${ID:-unknown}"
DISTRO_VERSION="${VERSION_ID:-0}"
DISTRO_NAME="${PRETTY_NAME:-$DISTRO_ID $DISTRO_VERSION}"

info "Система: ${DISTRO_NAME}"
info "Архитектура: $(uname -m)"

case "$DISTRO_ID" in
  debian|ubuntu|raspbian) ;;
  openmediavault)
    info "OpenMediaVault - базовая ОС Debian."
    DISTRO_ID="debian"
    ;;
  *)
    warn "Дистрибутив '$DISTRO_ID' не тестировался."
    warn "Скрипт рассчитан на Debian/Ubuntu. Продолжаем на свой риск."
    ;;
esac

# ── Helper: check if command exists ──────────────────────────────────

has_cmd() { command -v "$1" &>/dev/null; }

# ── Step 1: System packages ─────────────────────────────────────────

step "Системные пакеты"

info "Обновление списка пакетов..."
apt-get update -qq

PACKAGES_TO_INSTALL=()

for pkg in curl wget ca-certificates gnupg build-essential python3 unzip; do
  if ! dpkg -s "$pkg" &>/dev/null; then
    PACKAGES_TO_INSTALL+=("$pkg")
  fi
done

if [ ${#PACKAGES_TO_INSTALL[@]} -gt 0 ]; then
  info "Установка: ${PACKAGES_TO_INSTALL[*]}"
  apt-get install -y -qq "${PACKAGES_TO_INSTALL[@]}"
  ok "Системные пакеты установлены."
else
  ok "Все необходимые системные пакеты уже установлены."
fi

# ── Step 2: Node.js ─────────────────────────────────────────────────

step "Node.js"

install_node() {
  info "Установка Node.js ${INSTALL_NODE_MAJOR}.x через NodeSource..."

  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes

  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${INSTALL_NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list

  apt-get update -qq
  apt-get install -y -qq nodejs

  ok "Node.js $(node -v) установлен."
}

if has_cmd node; then
  NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge "$REQUIRED_NODE_MAJOR" ]; then
    ok "Node.js $(node -v) - OK (>= ${REQUIRED_NODE_MAJOR})."
  else
    warn "Node.js $(node -v) слишком старый (требуется >= ${REQUIRED_NODE_MAJOR})."
    install_node
  fi
else
  warn "Node.js не найден."
  install_node
fi

if ! has_cmd npm; then
  err "npm не найден после установки Node.js. Что-то пошло не так."
  exit 1
fi

info "npm $(npm -v)"

# ── Step 3: Application dependencies ────────────────────────────────

step "Зависимости приложения"

cd "$APP_DIR"
info "Рабочая директория: $APP_DIR"

info "Запуск npm install..."
if [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != "root" ]; then
  # Run npm install as the service user to avoid root-owned files
  su - "$SERVICE_USER" -c "cd '$APP_DIR' && npm install --omit=dev"
else
  warn "SERVICE_USER не определён — npm install запускается от root."
  warn "Файлы в node_modules будут принадлежать root. Права будут исправлены на шаге chown."
  npm install --omit=dev
fi

ok "Node-модули установлены."

# ── Step 4: Data directory ────────────────────────────────────────────

step "Директория данных"

mkdir -p "$APP_DIR/data"
ok "data/ готова."

# ── Step 5: fb2cng converter (optional) ─────────────────────────────

step "FB2-конвертер (опционально)"

if [ -x "$APP_DIR/converter/fbc" ]; then
  ok "Конвертер fbc уже установлен."
else
  FB2CNG_VERSION="v1.1.8"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)  FB2CNG_ARCH="amd64" ;;
    aarch64|arm64) FB2CNG_ARCH="arm64" ;;
    i386|i686)     FB2CNG_ARCH="386" ;;
    armv7l|armhf)  FB2CNG_ARCH="" ;;
    *)             FB2CNG_ARCH="" ;;
  esac

  if [ -n "$FB2CNG_ARCH" ]; then
    info "Скачивание fb2cng ${FB2CNG_VERSION} (${FB2CNG_ARCH})..."
    mkdir -p "$APP_DIR/converter"
    TMPZIP=$(mktemp /tmp/fbc-XXXXXX.zip)
    if curl -fsSL "https://github.com/rupor-github/fb2cng/releases/download/${FB2CNG_VERSION}/fbc-linux-${FB2CNG_ARCH}.zip" -o "$TMPZIP"; then
      unzip -qo "$TMPZIP" -d "$APP_DIR/converter"
      chmod +x "$APP_DIR/converter/fbc"
      rm -f "$TMPZIP"
      ok "Конвертер fbc установлен."
    else
      warn "Не удалось скачать fb2cng - конвертация FB2->EPUB не будет работать."
      rm -f "$TMPZIP"
    fi
  else
    warn "Архитектура ${ARCH} не поддерживается fb2cng - конвертер пропущен."
  fi
fi

# ── Step 6: systemd service (optional) ──────────────────────────────

step "Автозапуск (systemd)"

setup_systemd() {
  local SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

  cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=INPX Library Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(which node) src/server-entry.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  ok "Сервис ${SERVICE_NAME} создан и добавлен в автозагрузку."
  info "Управление:"
  info "  sudo systemctl start ${SERVICE_NAME}"
  info "  sudo systemctl stop ${SERVICE_NAME}"
  info "  sudo systemctl status ${SERVICE_NAME}"
  info "  sudo journalctl -u ${SERVICE_NAME} -f"
}

if has_cmd systemctl; then
  if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
    ok "Сервис ${SERVICE_NAME} уже настроен."
    read -rp "Пересоздать systemd-юнит? [y/N] " REPLY
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      setup_systemd
    fi
  else
    read -rp "Настроить автозапуск через systemd? [Y/n] " REPLY
    if [[ ! "$REPLY" =~ ^[Nn]$ ]]; then
      setup_systemd
    fi
  fi
else
  warn "systemd не обнаружен - автозапуск не настроен."
  info "Запускайте сервер вручную: cd $APP_DIR && node src/server-entry.js"
fi

# ── Fix ownership ────────────────────────────────────────────────────

step "Права доступа"

if [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != "root" ]; then
  info "Установка прав для $SERVICE_USER..."
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"
  ok "Права на $APP_DIR установлены."
else
  warn "SERVICE_USER не определён или root — chown пропущен."
  warn "Убедитесь, что права на $APP_DIR корректны для запуска сервера."
fi

# ── Done ─────────────────────────────────────────────────────────────

step "Готово!"

echo ""
ok "INPX Library Server установлен."
echo ""
info "Что дальше:"
info "  1. Запустите сервер:"
if has_cmd systemctl && [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  info "       sudo systemctl start ${SERVICE_NAME}"
else
  info "       cd ${APP_DIR} && ./start.sh"
fi
info "  2. Откройте в браузере: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'IP-адрес'):3000"
info "  3. Войдите как admin / admin"
info "  4. Укажите путь к библиотеке и .inpx в админ-панели"
echo ""
