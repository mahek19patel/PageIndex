import urllib.request
import json
import uuid
import os

sid = str(uuid.uuid4())
upload_folder = "uploads"
os.makedirs(upload_folder, exist_ok=True)
with open(os.path.join(upload_folder, f"{sid}_test.pdf"), "w") as f:
    f.write("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< \n/Type /Catalog \n/Pages 2 0 R \n>> \nendobj\n2 0 obj\n<< \n/Type /Pages \n/Kids [3 0 R] \n/Count 1 \n>> \nendobj\n3 0 obj\n<< \n/Type /Page \n/Parent 2 0 R \n/MediaBox [0 0 612 792] \n/Contents 4 0 R \n/Resources << \n/Font << \n/F1 5 0 R \n>> \n>> \n>> \nendobj\n4 0 obj\n<< /Length 54 >> \nstream\nBT\n/F1 24 Tf\n100 700 Td\n(Hello World) Tj\nET\nendstream\nendobj\n5 0 obj\n<< \n/Type /Font \n/Subtype /Type1 \n/BaseFont /Helvetica \n>> \nendobj\nxref\n0 6\n0000000000 65535 f \n0000000018 00000 n \n0000000069 00000 n \n0000000128 00000 n \n0000000244 00000 n \n0000000350 00000 n \ntrailer\n<< \n/Size 6 \n/Root 1 0 R \n>> \nstartxref\n440\n%%EOF")

def debug():
    url = f"http://127.0.0.1:5000/api/process/{sid}"
    data = json.dumps({"model": "gemini-2.5-flash"}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        response = urllib.request.urlopen(req)
        print("Success:", response.read().decode())
    except urllib.error.HTTPError as e:
        print("HTTP Error:", e.code)
        print("Response:", e.read().decode())
    except Exception as e:
        print("Other Error:", e)

debug()
