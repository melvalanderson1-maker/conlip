import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request

url, secreto, page_id = sys.argv[1], sys.argv[2], sys.argv[3]
ahora = int(time.time() * 1000)
payload = {
    "object": "page",
    "entry": [{
        "id": page_id, "time": ahora,
        "messaging": [{
            "sender": {"id": "1234567890123456"}, "recipient": {"id": page_id}, "timestamp": ahora,
            "message": {"mid": f"m_prueba_{ahora}", "text": "Mensaje de prueba simulado"},
        }],
    }],
}
cuerpo = json.dumps(payload).encode()
firma = "sha256=" + hmac.new(secreto.encode(), cuerpo, hashlib.sha256).hexdigest()
req = urllib.request.Request(url, data=cuerpo, method="POST",
                             headers={"Content-Type": "application/json", "X-Hub-Signature-256": firma})
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        print(r.status, r.read().decode())
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())