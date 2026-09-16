#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <full|server> <server-artifact.tgz> [web-artifact.tgz]" >&2
  exit 64
}

wait_for_url() {
  local url=$1
  local label=$2
  for _attempt in $(seq 1 60); do
    if curl --max-time 2 -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "${label} did not become ready: ${url}" >&2
  return 1
}

wait_for_status() {
  local url=$1
  local expected_status=$2
  local label=$3
  local status
  for _attempt in $(seq 1 60); do
    status=$(curl --max-time 2 -sS -o /dev/null -w '%{http_code}' "${url}" || true)
    if [[ ${status} == "${expected_status}" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "${label} did not return ${expected_status}: ${url} (last ${status:-none})" >&2
  return 1
}

[[ $# -ge 2 ]] || usage
[[ ${EUID} -eq 0 ]] || {
  echo "run as root" >&2
  exit 77
}

profile=$1
server_archive=$(readlink -f "$2")
web_archive=""
if [[ ${profile} == "full" ]]; then
  [[ $# -eq 3 ]] || usage
  web_archive=$(readlink -f "$3")
elif [[ ${profile} == "server" ]]; then
  [[ $# -eq 2 ]] || usage
else
  usage
fi

for archive in "${server_archive}" ${web_archive:+"${web_archive}"}; do
  [[ -f ${archive} && -f ${archive}.sha256 ]] || {
    echo "artifact or checksum sidecar missing: ${archive}" >&2
    exit 66
  }
  (
    cd "$(dirname "${archive}")"
    sha256sum -c "$(basename "${archive}").sha256"
  )
done

if [[ ! -x /usr/local/bin/bun && -x /root/.bun/bin/bun ]]; then
  install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
fi
for runtime in /usr/local/bin/bun /usr/bin/node; do
  [[ -x ${runtime} ]] || {
    echo "required runtime missing: ${runtime}" >&2
    exit 69
  }
done
command -v curl >/dev/null || {
  echo "curl is required for service readiness checks" >&2
  exit 69
}
if [[ ! -e /etc/pointer/server.env && -f /etc/pointer-lite.env ]]; then
  install -d -m 0755 /etc/pointer
  ln -s /etc/pointer-lite.env /etc/pointer/server.env
fi
[[ -f /etc/pointer/server.env ]] || {
  echo "/etc/pointer/server.env must exist before installation" >&2
  exit 78
}

release_id=$(basename "${server_archive}" | sed -E 's/^pointer-server-([0-9a-f]{12})\.tgz$/\1/')
[[ ${release_id} =~ ^[0-9a-f]{12}$ ]] || {
  echo "server artifact name does not contain a valid release identity" >&2
  exit 65
}
if [[ ${profile} == "full" ]]; then
  web_id=$(basename "${web_archive}" | sed -E 's/^pointer-web-([0-9a-f]{12})\.tgz$/\1/')
  [[ ${web_id} == "${release_id}" ]] || {
    echo "server and web artifact identities differ" >&2
    exit 65
  }
  command -v nginx >/dev/null || {
    echo "nginx is required for the full profile" >&2
    exit 69
  }
fi

install -d -m 0755 /opt/pointer/releases /etc/pointer
id pointer >/dev/null 2>&1 || useradd --system --home /opt/pointer --shell /usr/sbin/nologin pointer
release_directory=/opt/pointer/releases/${release_id}
[[ ! -e ${release_directory} ]] || {
  echo "release already exists: ${release_directory}" >&2
  exit 73
}
install -d -o pointer -g pointer -m 0755 "${release_directory}/server"
tar -xzf "${server_archive}" -C "${release_directory}/server"

if [[ ${profile} == "full" ]]; then
  install -d -o pointer -g pointer -m 0755 "${release_directory}/web"
  tar -xzf "${web_archive}" -C "${release_directory}/web"
fi
chown -R pointer:pointer "${release_directory}"

if [[ -L /opt/pointer/current ]]; then
  previous_target=$(readlink -f /opt/pointer/current)
  ln -sfn "${previous_target}" /opt/pointer/previous
fi
ln -sfn "${release_directory}" /opt/pointer/current

install -m 0644 deployment/systemd/pointer-server.service /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/pointer-server.service.d
if [[ ${profile} == "full" ]]; then
  printf '%s\n' '[Service]' 'Environment=BIND=127.0.0.1' 'Environment=PORT=4000' \
    > /etc/systemd/system/pointer-server.service.d/profile.conf
  install -m 0644 deployment/systemd/pointer-web.service /etc/systemd/system/
  install -m 0644 deployment/systemd/pointer-router.service /etc/systemd/system/
  install -m 0644 deployment/router/proxy-params.conf /etc/pointer/proxy-params.conf
  sed \
    -e 's#__PID_FILE__#/run/pointer-router.pid#g' \
    -e 's#__LISTEN_PORT__#8080#g' \
    -e 's#__SERVER_PORT__#4000#g' \
    -e 's#__WEB_PORT__#3000#g' \
    -e 's#__PROXY_PARAMS__#/etc/pointer/proxy-params.conf#g' \
    deployment/router/pointer-router.conf.template > /etc/pointer/router.conf
else
  printf '%s\n' '[Service]' 'Environment=BIND=0.0.0.0' 'Environment=PORT=4000' \
    > /etc/systemd/system/pointer-server.service.d/profile.conf
fi

systemctl daemon-reload
systemctl enable pointer-server.service
if [[ ${profile} == "full" ]]; then
  systemctl enable pointer-web.service pointer-router.service
  systemctl stop pointer-router.service
  systemctl restart pointer-server.service
  systemctl restart pointer-web.service
  systemctl restart pointer-router.service
  wait_for_url http://127.0.0.1:8080/healthz "Pointer router/server"
  wait_for_url http://127.0.0.1:8080/_pointer/web/healthz "Pointer router/web"
  wait_for_status http://127.0.0.1:8080/v1/models 401 "Pointer router v1 inference"
  wait_for_status http://127.0.0.1:8080/v1beta/models 401 "Pointer router v1beta inference"
else
  systemctl disable --now pointer-router.service pointer-web.service 2>/dev/null || true
  systemctl restart pointer-server.service
  wait_for_url http://127.0.0.1:4000/healthz "Pointer server"
fi

echo "installed Pointer ${profile} release ${release_id}"
