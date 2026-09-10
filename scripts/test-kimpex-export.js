// Confirms the generated .xlsx file matches Kimpex's required template
// exactly: sheet named "Orders", these 15 headers in this exact order
// (verified directly against their reference file
// "DropShip E-Market - EN 1.xlsx" and upload-instructions doc, not
// guessed), and that sample row data round-trips correctly.
//
// Hermetic - no .env, no Supabase, no network. Builds the workbook from
// in-memory sample rows and parses the resulting buffer back with
// exceljs to inspect it, the same library used to generate it.
//
// Run with: node scripts/test-kimpex-export.js

const ExcelJS = require('exceljs');
const { buildKimpexExportWorkbook, KIMPEX_HEADERS, SHEET_NAME } = require('../lib/kimpexExport');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

const EXPECTED_HEADERS = [
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

const sampleRows = [
  {
    order_number: '#1042',
    recipient_name: 'Alex Tremblay',
    ship_address_1: '123 Rue Principale',
    ship_address_2: 'Apt 4',
    ship_address_3: '',
    ship_city: 'Montreal',
    ship_postal_code: 'H2X 1Y6',
    ship_state: 'QC',
    ship_country: 'CA',
    buyer_phone_number: '+15145551234',
    buyer_email: 'alex@example.com',
    sku: 'KX-1001',
    product_name: 'Kimpex Test Helmet',
    quantity_purchased: 2,
    item_price: 129.99,
  },
];

async function main() {
  assert(
    EXPECTED_HEADERS.every((h, i) => KIMPEX_HEADERS[i] === h) && KIMPEX_HEADERS.length === EXPECTED_HEADERS.length,
    `KIMPEX_HEADERS matches Kimpex's exact reference template order (got ${JSON.stringify(KIMPEX_HEADERS)})`
  );
  assert(SHEET_NAME === 'Orders', `sheet name is "Orders" (got "${SHEET_NAME}")`);

  const buffer = await buildKimpexExportWorkbook(sampleRows);
  assert(Buffer.isBuffer(buffer) && buffer.length > 0, 'buildKimpexExportWorkbook() returns a non-empty Buffer');

  // Parse it back with the same library used to write it, to confirm the
  // actual generated file - not just the constant - has the right shape.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  assert(
    workbook.worksheets.length === 1 && workbook.worksheets[0].name === 'Orders',
    `the generated file has exactly one sheet named "Orders" (got ${JSON.stringify(workbook.worksheets.map((s) => s.name))})`
  );

  const sheet = workbook.getWorksheet('Orders');
  const headerRow = sheet.getRow(1).values.slice(1); // 1-indexed, leading undefined
  assert(
    JSON.stringify(headerRow) === JSON.stringify(EXPECTED_HEADERS),
    `the generated file's header row matches Kimpex's template exactly (got ${JSON.stringify(headerRow)})`
  );

  assert(sheet.rowCount === 2, `the generated file has 1 header row + 1 data row (got ${sheet.rowCount} rows)`);

  const dataRow = sheet.getRow(2).values.slice(1);
  assert(dataRow[0] === '#1042', `order-id column holds the Shopify order number, not an internal id (got "${dataRow[0]}")`);
  assert(dataRow[7] === 'QC', `ship-state column holds the 2-letter province code (got "${dataRow[7]}")`);
  assert(dataRow[8] === 'CA', `ship-country column holds the 2-letter country code (got "${dataRow[8]}")`);
  assert(dataRow[11] === 'KX-1001', `sku column is correct (got "${dataRow[11]}")`);
  assert(dataRow[13] === 2, `quantity-purchased column is correct (got ${dataRow[13]})`);
  assert(dataRow[14] === 129.99, `item-price column is correct (got ${dataRow[14]})`);

  if (process.exitCode === 1) {
    console.error('\nKimpex export format test FAILED');
  } else {
    console.log(
      '\nKimpex export format test passed: the generated .xlsx has the exact sheet name and column headers ' +
        "Kimpex's template requires, in the exact order, and sample data round-trips correctly through it."
    );
  }
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
