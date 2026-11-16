# Generates real Office test files (needs Microsoft Word + PowerPoint): powershell -File tests/make-office-fixtures.ps1
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'fixtures'
$icon = (Resolve-Path (Join-Path $PSScriptRoot '..\public\icon-192.png')).Path

# ---- Word 97-2003 .doc with heading, formatting and a table
if (-not (Test-Path (Join-Path $dir 'legacy.doc'))) {
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Add()
$sel = $word.Selection
$sel.Style = $doc.Styles.Item(-2)   # Heading 1
$sel.TypeText('Legacy Report'); $sel.TypeParagraph()
$sel.Style = $doc.Styles.Item(-1)   # Normal
$sel.TypeText('This document was saved in the old Word 97-2003 format. ')
$sel.Font.Bold = 1; $sel.TypeText('Bold words'); $sel.Font.Bold = 0
$sel.TypeText(' are followed by normal text.'); $sel.TypeParagraph()
$table = $doc.Tables.Add($sel.Range, 3, 2)
$cells = @(@('Region', 'Sales'), @('North', '1200'), @('South', '950'))
for ($r = 1; $r -le 3; $r++) { for ($c = 1; $c -le 2; $c++) { $table.Cell($r, $c).Range.Text = $cells[$r - 1][$c - 1] } }
$sel.EndKey(6) | Out-Null
$sel.TypeParagraph(); $sel.TypeText('Closing paragraph after the table.')
$doc.SaveAs([ref](Join-Path $dir 'legacy.doc'), [ref]0)
$doc.Close()
$word.Quit()
}

# ---- PowerPoint with layouts (placeholders), bullets, a picture and a table
$pp = New-Object -ComObject PowerPoint.Application
$pres = $pp.Presentations.Add(0)
$s1 = $pres.Slides.Add(1, 1)   # ppLayoutTitle
$s1.Shapes.Item(1).TextFrame.TextRange.Text = 'Quarterly Review'
$s1.Shapes.Item(2).TextFrame.TextRange.Text = 'Prepared with Dr.Doc'
$s2 = $pres.Slides.Add(2, 2)   # ppLayoutText
$s2.Shapes.Item(1).TextFrame.TextRange.Text = 'Highlights'
$s2.Shapes.Item(2).TextFrame.TextRange.Text = "Revenue grew 12%`rTwo new offices`rCustomer score 4.6"
$s3 = $pres.Slides.Add(3, 11)  # ppLayoutTitleOnly
$s3.Shapes.Item(1).TextFrame.TextRange.Text = 'Numbers'
$s3.Shapes.AddPicture($icon, 0, -1, 40, 120, 160, 160) | Out-Null
$t = $s3.Shapes.AddTable(3, 2, 260, 130, 400, 120).Table
$vals = @(@('Quarter', 'Revenue'), @('Q1', '10.2'), @('Q2', '11.4'))
for ($r = 1; $r -le 3; $r++) { for ($c = 1; $c -le 2; $c++) { $t.Cell($r, $c).Shape.TextFrame.TextRange.Text = $vals[$r - 1][$c - 1] } }
$pres.SaveAs((Join-Path $dir 'slides.pptx'), 24)
$pres.Close()
$pp.Quit()

# ---- "Scanned" page: text drawn into an image (no real text layer)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1654, 2339   # A4 @ 200 dpi
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = 'AntiAlias'
$title = New-Object System.Drawing.Font('Arial', 28, [System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font('Times New Roman', 14)
$g.DrawString('INVOICE 2026-117', $title, [System.Drawing.Brushes]::Black, 140, 160)
$lines = @('Billed to: Sunrise Traders, Pune', 'Item: Office chairs, quantity 12', 'Total amount due: 45,600 rupees', 'Please pay within thirty days of receipt.')
for ($i = 0; $i -lt $lines.Count; $i++) { $g.DrawString($lines[$i], $body, [System.Drawing.Brushes]::Black, 140, 360 + $i * 90) }
$bmp.Save((Join-Path $dir 'scan.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
'office fixtures written'
