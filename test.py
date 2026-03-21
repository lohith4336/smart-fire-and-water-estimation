import requests

url = 'http://localhost:5000/api/reports'
data = {'lat': 20.0, 'lng': 78.0, 'address': 'Test'}
try:
    res = requests.post(url, data=data)
    print(f'Status: {res.status_code}')
    print(f'Content Type: {res.headers.get("Content-Type")}')
    print(f'Length: {len(res.content)}')
    print(f'Content Length: {len(res.text)}')
    print(f'Content: {res.text[:200]}')
except Exception as e:
    print(f'Error: {e}')
