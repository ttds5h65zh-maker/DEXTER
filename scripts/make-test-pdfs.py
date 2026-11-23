import sys, os, subprocess
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from pypdf import PdfReader, PdfWriter

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

# 1. reportlab, standard Type1 font (WinAnsi), compressed streams, two columns of short lines
c = canvas.Canvas(os.path.join(out, '10-reportlab-notice.pdf'), pagesize=A4)
c.setTitle('Parking permit notice')
y = 270 * mm
def line(t, size=11, font='Helvetica'):
    global y
    c.setFont(font, size); c.drawString(22 * mm, y, t); y -= size * 0.55 * mm + 4 * mm
line('Falcon Bay University (fictional) – Campus Services', 9, 'Helvetica-Oblique')
line('Parking permit renewal notice', 16, 'Helvetica-Bold')
line('Permits for the 2026/27 academic year must be renewed by 4 December 2026.')
line('Permits that are not renewed will expire on 31 December 2026 at 23:59.')
line("The fee has been reduced to AED 450 for students – it's payable online.")
line('Is your vehicle registered in your own name? If not, bring a letter from the owner.')
c.showPage()
y = 270 * mm
line('Page 2 – Collection', 14, 'Helvetica-Bold')
line('New permit stickers can be collected from Building C, Room 014, from 7 December.')
c.save()

# 2. reportlab, uncompressed content stream
c = canvas.Canvas(os.path.join(out, '11-reportlab-uncompressed.pdf'), pagesize=A4, pageCompression=0)
c.setFont('Times-Roman', 12)
c.drawString(25 * mm, 260 * mm, 'Reminder: the dentist appointment is on Wednesday, 25 November at 4:15 pm.')
c.drawString(25 * mm, 250 * mm, 'Please arrive ten minutes early and bring your insurance card.')
c.save()

# 3. image-only: shapes, no text
c = canvas.Canvas(os.path.join(out, '12-image-only.pdf'), pagesize=A4)
for i in range(12):
    c.rect(20 * mm + i * 12 * mm, 200 * mm, 10 * mm, 40 * mm, fill=1)
c.save()

# 4. encrypted copy of the notice
r = PdfReader(os.path.join(out, '10-reportlab-notice.pdf'))
w = PdfWriter()
for p in r.pages: w.add_page(p)
w.encrypt('secret123', algorithm='AES-128')
with open(os.path.join(out, '13-encrypted.pdf'), 'wb') as f: w.write(f)

# 5. not a PDF at all (a PNG renamed)
with open(os.path.join(out, '14-fake.pdf'), 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n' + b'\x00' * 200)

# 6. a long syllabus via LibreOffice (Word-style export), 25+ pages
html = ['<html><head><meta charset="utf-8"><title>Syllabus</title></head><body>',
        '<h1>MGMT 301: Operations Management (fictional)</h1>',
        '<p>Instructor: Dr. Aisha Rahman. Office hours: Tuesdays 13:00–15:00.</p>',
        '<p>The midterm exam will take place on 9 December 2026 at 10:00 in Hall B.</p>',
        '<p>The committee approved the use of calculators in the final exam.</p>',
        '<p>It is still unclear whether the guest lecture on 2 December will be recorded.</p>']
for wk in range(1, 41):
    html.append(f'<h2>Week {wk}</h2><p>' + ('Reading and discussion of supply chain case studies, with in-class exercises on capacity planning and queueing. ' * 6) + '</p>')
html.append('<p>The term project report is due on 18 December 2026 by 5pm via the course portal.</p>')
html.append('<p dir="rtl">ملاحظة: سيتم نشر الدرجات النهائية بعد أسبوعين.</p>')
html.append('</body></html>')
src = os.path.join(out, '15-syllabus.html')
open(src, 'w', encoding='utf-8').write('\n'.join(html))
subprocess.run(['soffice', '--headless', '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', out, src], check=True, capture_output=True, timeout=180)
os.rename(os.path.join(out, '15-syllabus.pdf'), os.path.join(out, '15-libreoffice-syllabus.pdf'))
os.remove(src)
print(sorted(os.listdir(out)))
