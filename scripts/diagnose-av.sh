#!/usr/bin/env bash
# Run this against the TEST environment that's producing the 120s timeouts.
# Outputs a single block of evidence we need to confirm the diagnosis.
set +e
echo "==================== container status ===================="
docker compose ps clamav
echo
echo "==================== clamd PING ===================="
docker compose exec -T clamav clamdscan --ping 1
echo
echo "==================== clamd version + DB ===================="
docker compose exec -T clamav clamdscan --version
echo
echo "==================== last 60 lines of clamd log ===================="
docker compose logs --tail 60 clamav
echo
echo "==================== freshclam status ===================="
docker compose exec -T clamav ls -la /var/lib/clamav/
echo
echo "==================== EICAR INSTREAM scan (from inside clamav) ===================="
docker compose exec -T clamav sh -c 'wget -q -O /tmp/eicar.com https://secure.eicar.org/eicar.com && time clamdscan --stream /tmp/eicar.com'
echo
echo "==================== backend->clamd reachability ===================="
docker compose exec -T backend bash -c 'getent hosts clamav; echo "--- bash TCP PING ---"; exec 3<>/dev/tcp/clamav/3310 && printf "zPING\0" >&3 && timeout 5 cat <&3 && echo; echo "(end PING)"'
echo
echo "==================== END ===================="
