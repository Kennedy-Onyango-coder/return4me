from pathlib import Path
import sys

path = Path(r'c:\Users\barsh\Desktop\Return4me Project\return4me-main\reports\phase16-batch4-forensic-report.md')

if not path.exists():
    print('MISSING')
    sys.exit(1)

data = path.read_bytes()
size = len(data)
print('BYTES=' + str(size))

if size == 0:
    print('EMPTY')
    sys.exit(0)

txt = data.decode('utf-8')
chunk_size = 2200
chunks = [txt[i:i + chunk_size] for i in range(0, len(txt), chunk_size)]
for idx, chunk in enumerate(chunks, start=1):
    print('----- CHUNK ' + str(idx) + ' -----')
    print(chunk)

print('TOTAL_CHUNKS=' + str(len(chunks)))
