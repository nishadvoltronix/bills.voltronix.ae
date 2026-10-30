export const azureInvoice = (invoiceNumber = "DEMO-OCR-001") => ({
  content: "Fictional OCR Supplier\nJOB ID: OCR-TEST\nInvoice " + invoiceNumber,
  pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
  documents: [
    {
      fields: {
        VendorName: { valueString: "Fictional OCR Supplier", confidence: 0.99 },
        InvoiceId: { valueString: invoiceNumber, confidence: 0.98 },
        InvoiceDate: { valueDate: "2026-10-27", confidence: 0.99 },
        DueDate: { valueDate: "2026-11-26", confidence: 0.99 },
        PurchaseOrder: { valueString: "PO-FICTIONAL-001", confidence: 0.97 },
        CustomerId: { valueString: "OCR-TEST", confidence: 0.95 },
        SubTotal: {
          valueCurrency: { amount: 200, currencyCode: "AED" },
          confidence: 0.99,
        },
        TotalTax: {
          valueCurrency: { amount: 10, currencyCode: "AED" },
          confidence: 0.99,
        },
        InvoiceTotal: {
          valueCurrency: { amount: 210, currencyCode: "AED" },
          confidence: 0.99,
        },
        AmountDue: {
          valueCurrency: { amount: 1210, currencyCode: "AED" },
          confidence: 0.99,
        },
        Items: {
          valueArray: [
            {
              valueObject: {
                Description: {
                  valueString: "Fictional materials",
                  confidence: 0.99,
                },
                Quantity: { valueNumber: 2, confidence: 0.99 },
                UnitPrice: {
                  valueCurrency: { amount: 100, currencyCode: "AED" },
                  confidence: 0.99,
                },
                Amount: {
                  valueCurrency: { amount: 200, currencyCode: "AED" },
                  confidence: 0.99,
                },
              },
            },
          ],
        },
      },
    },
  ],
});
