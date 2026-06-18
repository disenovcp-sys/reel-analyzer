import json
import os
import re
import shutil
import tempfile
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

GEMINI_KEY = os.environ.get('GEMINI_API_KEY', '')


def download_instagram(url):
    try:
        import yt_dlp
    except ImportError:
        return None, None

    tmpdir = tempfile.mkdtemp()
    try:
        ydl_opts = {
            'outtmpl': os.path.join(tmpdir, 'video.%(ext)s'),
            'format': 'best[ext=mp4]/best',
            'quiet': True,
            'no_warnings': True,
            'nocheckcertificate': True,
            'socket_timeout': 20,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        files = [f for f in os.listdir(tmpdir) if os.path.isfile(os.path.join(tmpdir, f))]
        if not files:
            return None, None

        filepath = os.path.join(tmpdir, files[0])
        with open(filepath, 'rb') as f:
            data = f.read()

        ext = os.path.splitext(files[0])[1].lower().lstrip('.')
        ct = {'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime'}.get(ext, 'video/mp4')
        return data, ct
    except Exception as e:
        print(f'yt-dlp error: {e}')
        return None, None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def upload_to_gemini(data, content_type):
    init_req = urllib.request.Request(
        f'https://generativelanguage.googleapis.com/upload/v1beta/files?key={GEMINI_KEY}&uploadType=resumable',
        data=json.dumps({'file': {'displayName': 'reel'}}).encode(),
        headers={
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': str(len(data)),
            'X-Goog-Upload-Header-Content-Type': content_type,
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    with urllib.request.urlopen(init_req, timeout=30) as resp:
        upload_url = resp.headers.get('x-goog-upload-url')

    if not upload_url:
        raise Exception('No se obtuvo URL de upload de Gemini')

    upload_req = urllib.request.Request(
        upload_url,
        data=data,
        headers={
            'Content-Length': str(len(data)),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
        },
        method='POST',
    )
    with urllib.request.urlopen(upload_req, timeout=60) as resp:
        file_data = json.loads(resp.read())

    return (file_data.get('file') or file_data).get('uri')


def wait_active(file_uri):
    name = file_uri.split('/files/')[1]
    for _ in range(20):
        req = urllib.request.Request(
            f'https://generativelanguage.googleapis.com/v1beta/files/{name}?key={GEMINI_KEY}'
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            f = json.loads(resp.read())
        if f.get('state') == 'ACTIVE':
            return
        if f.get('state') == 'FAILED':
            raise Exception('Gemini no pudo procesar el video')
        time.sleep(2)
    raise Exception('Tiempo de espera agotado procesando el video')


def analyze(file_uri, mime_type):
    prompt = (
        'Analizá este video de referencia para benchmarking de contenido de una marca '
        'de ropa urbana argentina llamada Van Como Pina (VCP).\n\n'
        'Observá el video completo y analizá el hook visual, estructura narrativa, '
        'elementos visuales clave, y por qué generó engagement.\n\n'
        'Respondé ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después, '
        'sin bloques de código markdown):\n'
        '{\n'
        '  "hook_type": "curiosity_gap | dato_contraintuitivo | promesa_revelacion | conflicto | identificacion | otro",\n'
        '  "hook_breakdown": "descripción concreta del hook en 2-3 oraciones",\n'
        '  "narrative_structure": {\n'
        '    "hook": "qué pasa en los primeros 1-3 segundos",\n'
        '    "contexto": "cómo establece el contexto",\n'
        '    "tension": "qué tensión genera para mantener la atención",\n'
        '    "resolucion": "cómo resuelve o desenlaza",\n'
        '    "cta": "cierre y llamado a la acción si existe"\n'
        '  },\n'
        '  "visual_elements": "elementos visuales clave: estética, colores, montaje, texto en pantalla, audio",\n'
        '  "why_it_worked": "hipótesis de por qué generó engagement",\n'
        '  "vcp_adaptation": "cómo adaptar este mecanismo a un reel de VCP (ropa urbana argentina, target 18-35 años)"\n'
        '}'
    )

    body = json.dumps({
        'contents': [{'parts': [
            {'file_data': {'mime_type': mime_type, 'file_uri': file_uri}},
            {'text': prompt},
        ]}],
        'generationConfig': {'temperature': 0.4, 'maxOutputTokens': 1500},
    }).encode()

    req = urllib.request.Request(
        f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}',
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())

    text = data['candidates'][0]['content']['parts'][0]['text']
    m = re.search(r'\{[\s\S]*\}', text)
    if not m:
        raise Exception('Respuesta inesperada de Gemini')
    return json.loads(m.group(0))


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            url = body.get('url', '').strip()

            if not url:
                return self._json(400, {'error': 'URL requerida.'})
            if not GEMINI_KEY:
                return self._json(500, {'error': 'GEMINI_API_KEY no configurada.'})

            video_data, content_type = download_instagram(url)
            if not video_data:
                return self._json(422, {'error': 'No se pudo descargar el video. Instagram puede haber bloqueado la descarga.'})

            file_uri = upload_to_gemini(video_data, content_type)
            if not content_type.startswith('image/'):
                wait_active(file_uri)

            result = analyze(file_uri, content_type)
            self._json(200, result)

        except Exception as e:
            self._json(500, {'error': str(e)})

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass
