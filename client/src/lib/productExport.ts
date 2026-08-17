import * as XLSX from 'xlsx';
import type { Product } from '@/types';

export function exportProductsXlsx(products: Product[], filename = 'products.xlsx') {
  const rows = products.map((product) => ({
    Name: product.name,
    Brand: product.brand,
    Line: product.line,
    'Code/Shade': product.codeShade,
    Category: product.category,
    Quantity: product.quantity,
    'Min quantity': product.minQuantity,
    Unit: product.unit,
    Price: product.price,
    Supplier: product.supplier,
    Status: product.stockStatus,
    'To order': product.markedForPurchase ? 'yes' : '',
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Products');
  XLSX.writeFile(workbook, filename);
}
