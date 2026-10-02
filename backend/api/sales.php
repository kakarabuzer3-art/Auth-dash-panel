<?php
/**
 * Sales API - Simple Version
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

require_once __DIR__ . '/../config/database.php';
$conn = getDBConnection();

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit(); }

$input = json_decode(file_get_contents('php://input'), true);
$action = $input['action'] ?? '';

function verifyToken($token) {
    try {
        $parts = explode('_', $token);
        if (count($parts) !== 2) return false;
        $payload = json_decode(base64_decode($parts[0]), true);
        return $payload && isset($payload['exp']) && time() <= $payload['exp'];
    } catch (Exception $e) { return false; }
}

function generateInvoice($conn) {
    $year = date('Y');
    $result = $conn->query("SELECT COUNT(*) as count FROM sales WHERE YEAR(created_at) = $year");
    $count = $result->fetch_assoc()['count'];
    return 'INV-' . $year . '-' . str_pad($count + 1, 4, '0', STR_PAD_LEFT);
}

$token = $input['token'] ?? '';
$authenticated = verifyToken($token);

switch ($action) {
    case 'getSales':
        $search = $input['search'] ?? '';
        $where = !empty($search) ? "WHERE invoice_number LIKE '%$search%' OR customer_name LIKE '%$search%'" : '';
        $result = $conn->query("SELECT * FROM sales $where ORDER BY created_at DESC");
        $sales = [];
        while ($row = $result->fetch_assoc()) $sales[] = $row;
        echo json_encode(['success' => true, 'data' => $sales]);
        break;
        
    case 'getSale':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("SELECT * FROM sales WHERE id = ?");
        $stmt->bind_param("i", $id);
        $stmt->execute();
        $result = $stmt->get_result();
        $sale = $result->num_rows > 0 ? $result->fetch_assoc() : null;
        $stmt->close();
        if ($sale) {
            $itemsStmt = $conn->prepare("SELECT si.*, p.product_name FROM sale_items si LEFT JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?");
            $itemsStmt->bind_param("i", $id);
            $itemsStmt->execute();
            $itemsResult = $itemsStmt->get_result();
            $sale['items'] = [];
            while ($item = $itemsResult->fetch_assoc()) $sale['items'][] = $item;
            $itemsStmt->close();
        }
        echo json_encode(['success' => true, 'data' => $sale]);
        break;
        
    case 'createSale':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $items = $input['items'] ?? [];
        if (empty($items)) { echo json_encode(['success' => false, 'message' => 'Items required']); break; }
        
        $total_amount = 0;
        foreach ($items as $item) $total_amount += $item['quantity'] * $item['unit_price'];
        $discount = $input['discount'] ?? 0;
        $tax = $input['tax'] ?? 0;
        $grand_total = $total_amount - $discount + $tax;
        $customer_name = $input['customer_name'] ?? null;
        $customer_phone = $input['customer_phone'] ?? null;
        $payment_method = $input['payment_method'] ?? 'cash';
        
        $payload = json_decode(base64_decode(explode('_', $token)[0]), true);
        $user_id = $payload['user_id'] ?? null;
        $invoice_number = generateInvoice($conn);
        
        $conn->begin_transaction();
        try {
            $stmt = $conn->prepare("INSERT INTO sales (invoice_number, customer_name, customer_phone, total_amount, discount, tax, grand_total, payment_method, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)");
            $stmt->bind_param("ssssdddsi", $invoice_number, $customer_name, $customer_phone, $total_amount, $discount, $tax, $grand_total, $payment_method, $user_id);
            if ($stmt->execute()) {
                $sale_id = $stmt->insert_id;
                foreach ($items as $item) {
                    $itemTotal = $item['quantity'] * $item['unit_price'];
                    $itemStmt = $conn->prepare("INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, discount, total) VALUES (?, ?, ?, ?, ?, ?)");
                    $itemStmt->bind_param("iiidds", $sale_id, $item['product_id'], $item['quantity'], $item['unit_price'], $item['discount'], $itemTotal);
                    $itemStmt->execute();
                    $itemStmt->close();
                    
                    $updateStock = $conn->prepare("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?");
                    $updateStock->bind_param("ii", $item['quantity'], $item['product_id']);
                    $updateStock->execute();
                    $updateStock->close();
                }
                $stmt->close();
                $conn->commit();
                echo json_encode(['success' => true, 'message' => 'Sale created', 'invoice_number' => $invoice_number]);
            } else {
                $conn->rollback();
                echo json_encode(['success' => false, 'message' => 'Error']);
            }
        } catch (Exception $e) { $conn->rollback(); echo json_encode(['success' => false, 'message' => 'Error']); }
        break;
        
    case 'getTodaySales':
        $today = date('Y-m-d');
        $result = $conn->query("SELECT COALESCE(SUM(grand_total), 0) as total, COUNT(*) as count FROM sales WHERE DATE(created_at) = '$today' AND status = 'completed'");
        $row = $result->fetch_assoc();
        echo json_encode(['success' => true, 'data' => ['total' => floatval($row['total']), 'count' => $row['count']]]);
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
