const ExcelJS = require('exceljs');

// Exact column headers, in this exact order, and exact sheet name "Orders" -
// confirmed directly against Kimpex's reference template
// ("DropShip E-Market - EN 1.xlsx") and their upload-instructions doc, not
// guessed.
const SHEET_NAME = 'Orders';
const KIMPEX_HEADERS = [
  'order-id',
  'recipient-name',
  'ship-address-1',
  'ship-address-2',
  'ship-address-3',
  'ship-city',
  'ship-postal-code',
  'ship-state',
  'ship-country',
  'buyer-phone-number',
  'buyer-email',
  'sku',
  'product-name',
  'quantity-purchased',
  'item-price',
];

/**
 * Builds the Kimpex "Orders" upload .xlsx file from kimpex_pending_orders
 * rows (snake_case DB columns). Returns a Buffer, ready to send as an
 * attachment.
 *
 * `order-id` is Kimpex's own order-tracking number, but per their doc this
 * is "the e-Market order number" - i.e. our external reference, not an
 * internal database id - so it's the Shopify order NUMBER (order_number,
 * e.g. "#1042"), matching what customer_refs uses for Thibault, not the
 * row's own database id or the raw Shopify order id.
 */
async function buildKimpexExportWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(SHEET_NAME);

  sheet.addRow(KIMPEX_HEADERS);

  for (const row of rows) {
    sheet.addRow([
      row.order_number,
      row.recipient_name,
      row.ship_address_1,
      row.ship_address_2,
      row.ship_address_3,
      row.ship_city,
      row.ship_postal_code,
      row.ship_state,
      row.ship_country,
      row.buyer_phone_number,
      row.buyer_email,
      row.sku,
      row.product_name,
      row.quantity_purchased,
      row.item_price,
    ]);
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildKimpexExportWorkbook, KIMPEX_HEADERS, SHEET_NAME };
