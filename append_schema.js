const fs = require('fs');

const appendContent = `

model PurchaseRequest {
  id              String                @id @default(uuid())
  prNumber        String                @unique
  department      String?
  status          PRStatus              @default(DRAFT)
  requestedBy     String?
  approvedBy      String?
  notes           String?
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
  items           PurchaseRequestItem[]
  rfqs            RequestForQuotation[]
}

model PurchaseRequestItem {
  id                String          @id @default(uuid())
  purchaseRequestId String
  inventoryItemId   String
  quantity          Float
  unit              String?
  notes             String?
  purchaseRequest   PurchaseRequest @relation(fields: [purchaseRequestId], references: [id])
  inventoryItem     InventoryItem   @relation(fields: [inventoryItemId], references: [id])
}

model RequestForQuotation {
  id                String            @id @default(uuid())
  rfqNumber         String            @unique
  purchaseRequestId String?
  status            RFQMasterStatus   @default(OPEN)
  deadline          DateTime?
  notes             String?
  createdBy         String?
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt
  purchaseRequest   PurchaseRequest?  @relation(fields: [purchaseRequestId], references: [id])
  quotations        VendorQuotation[]
}

model VendorQuotation {
  id            String                @id @default(uuid())
  rfqId         String
  vendorId      String
  status        QuotationReviewStatus @default(PENDING)
  totalAmount   Float                 @default(0)
  validUntil    DateTime?
  notes         String?
  createdAt     DateTime              @default(now())
  updatedAt     DateTime              @updatedAt
  rfq           RequestForQuotation   @relation(fields: [rfqId], references: [id])
  vendor        Vendor                @relation(fields: [vendorId], references: [id])
  items         VendorQuotationItem[]
}

model VendorQuotationItem {
  id                String          @id @default(uuid())
  vendorQuotationId String
  itemName          String
  quantity          Float
  unit              String
  quotedRate        Float?
  notes             String?
  vendorQuotation   VendorQuotation @relation(fields: [vendorQuotationId], references: [id])
}

model Warehouse {
  id          String         @id @default(uuid())
  name        String
  location    String?
  type        String?        // e.g., Cold Storage, Raw Material
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt
  bins        WarehouseBin[]
  grnItems    GoodsReceiptItem[]
  movements   StockMovement[]
}

model WarehouseBin {
  id          String         @id @default(uuid())
  warehouseId String
  code        String         // e.g., RACK-A-1
  description String?
  warehouse   Warehouse      @relation(fields: [warehouseId], references: [id])
  grnItems    GoodsReceiptItem[]
  movements   StockMovement[]
}

model InventoryBatch {
  id              String        @id @default(uuid())
  inventoryItemId String
  batchNumber     String
  lotNumber       String?
  mfgDate         DateTime?
  expDate         DateTime?
  initialQty      Float
  currentQty      Float
  status          String        @default("ACTIVE")
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id])
}

model AuditLog {
  id          String   @id @default(uuid())
  module      String
  action      String
  recordId    String?
  oldValue    Json?
  newValue    Json?
  performedBy String?
  ipAddress   String?
  timestamp   DateTime @default(now())
}

enum PRStatus {
  DRAFT
  PENDING_APPROVAL
  APPROVED
  REJECTED
  CONVERTED_TO_RFQ
  CONVERTED_TO_PO
}

enum RFQMasterStatus {
  OPEN
  CLOSED
  CANCELLED
}

enum QuotationReviewStatus {
  PENDING
  REVIEWING
  ACCEPTED
  REJECTED
}
`;

fs.appendFileSync('c:/Users/Administrator/Documents/ERP-backend/prisma/schema.prisma', appendContent);
console.log('Appended models to schema.prisma');
