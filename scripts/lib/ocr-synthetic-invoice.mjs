// Valid, locally generated invoice fixtures. No external invoice/customer data.
const pdfText = value => value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

export function syntheticInvoicePdf(invoiceNumber, { multipage = false } = {}) {
  if (!/^DEMO-[A-Z0-9-]{1,95}$/.test(invoiceNumber))
    throw new Error("Synthetic invoices require a bounded DEMO identifier.");
  const lines = [
    [48, 792, 19, "INVOICE - SYNTHETIC TEST ONLY"],
    [48, 762, 14, "Fictional OCR Supplier"],
    [48, 741, 10, "No real company, goods, customer or payment obligation"],
    [48, 710, 12, `Invoice number: ${invoiceNumber}`],
    [48, 690, 12, "Invoice date: 28 October 2026"],
    [48, 670, 12, "Due date: 27 November 2026"],
    [48, 650, 12, "Purchase order: PO-DEMO-001"],
    [48, 620, 12, "Bill to: Fictional Test Customer"],
    [48, 600, 12, "Currency: AED"],
    [48, 550, 11, "Description"], [282, 550, 11, "Quantity"],
    [362, 550, 11, "Unit price"], [482, 550, 11, "Amount"],
    [48, 520, 11, "Fictional materials"], [305, 520, 11, "2"],
    [370, 520, 11, "100.00"], [482, 520, 11, "200.00"],
    [360, 460, 12, "Subtotal AED"], [482, 460, 12, "200.00"],
    [360, 435, 12, "VAT (5%) AED"], [482, 435, 12, "10.00"],
    [360, 405, 14, "Total AED"], [482, 405, 14, "210.00"],
    [48, 330, 10, "Amounts and tax above are fictional test values."],
    [48, 312, 10, "Not valid for accounting, payment or tax purposes."],
  ];
  const pages = [lines];
  if (multipage) pages.push([
    [48, 792, 17, "SYNTHETIC INVOICE - CONTINUATION"],
    [48, 754, 12, `Invoice number: ${invoiceNumber}`],
    [48, 718, 11, "Page 2: fictional delivery notes only. No additional charges."],
    [48, 690, 11, "The invoice total and all financial line items are on page 1."],
  ]);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, page] of pages.entries()) {
    const stream = page.map(([x, y, size, value]) => `BT /F1 ${size} Tf ${x} ${y} Td (${pdfText(value)}) Tj ET`).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`);
  }
  let content = "%PDF-1.4\n% Synthetic invoice fixture\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content, "ascii"));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content, "ascii");
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content, "ascii");
}
