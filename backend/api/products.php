<?php
/**
 * Products API - CRUD operations
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

$headers = getallheaders();
$auth = $headers['Authorization'] ?? '';
$token = str_replace('Bearer ', '', $auth);

function verifyToken($conn, $token) {
    try {
        $parts = explode('_', $token);
        if (count($parts) !== 2) return false;
        $payload = json_decode(base64_decode($parts[0]), true);
        if (!$payload || !isset($payload['exp']) || time() > $payload['exp']) return false;
        $stmt = $conn->prepare("SELECT id FROM users WHERE id = ? AND status = 'active'");
        $stmt->bind_param("i", $payload['user_id']);
        $stmt->execute();
        $result = $stmt->get_result();
        $stmt->close();
        return $result->num_rows === 1;
    } catch (Exception $e) { return false; }
}

$authenticated = verifyToken($conn, $token);

switch ($action) {
    case 'getProducts':
        $page = $input['page'] ?? 1;
        $limit = $input['limit'] ?? 50;
        $offset = ($page - 1) * $limit;
        $search = $input['search'] ?? '';
        $where = !empty($search) ? "WHERE product_name LIKE '%$search%' OR sku LIKE '%$search%'" : '';
        $result = $conn->query("SELECT * FROM products $where ORDER BY created_at DESC LIMIT $limit OFFSET $offset");
        $products = [];
        while ($row = $result->fetch_assoc()) $products[] = $row;
        $countResult = $conn->query("SELECT COUNT(*) as total FROM products $where");
        echo json_encode(['success' => true, 'data' => $products, 'total' => $countResult->fetch_assoc()['total']]);
        break;
        
    case 'getProduct':
        $id = $input['id'] ?? 0;
        $stmt = $conn->prepare("SELECT * FROM products WHERE id = ?");
        $stmt->bind_param("i", $id);
        $stmt->execute();
        $result = $stmt->get_result();
        $product = $result->num_rows > 0 ? $result->fetch_assoc() : null;
        $stmt->close();
        echo json_encode(['success' => true, 'data' => $product]);
        break;
        
    case 'createProduct':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $product_name = $input['product_name'] ?? '';
        if (empty($product_name)) { echo json_encode(['success' => false, 'message' => 'Product name required']); break; }
        $stmt = $conn->prepare("INSERT INTO products (product_name, sku, category, description, price, cost, stock_quantity, min_stock, image, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')");
        $stmt->bind_param("ssssddiii", $input['product_name'], $input['sku'], $input['category'], $input['description'], $input['price'], $input['cost'], $input['stock_quantity'], $input['min_stock']);
        if ($stmt->execute()) {
            $id = $stmt->insert_id;
            $logStmt = $conn->prepare("INSERT INTO stock_transactions (product_id, transaction_type, quantity, notes) VALUES (?, 'in', ?, 'Initial stock')");
            $logStmt->bind_param("ii", $id, $input['stock_quantity']);
            $logStmt->execute();
            $logStmt->close();
            echo json_encode(['success' => true, 'message' => 'Product created', 'id' => $id]);
        } else {
            echo json_encode(['success' => false, 'message' => 'Error creating product']);
        }
        $stmt->close();
        break;
        
    case 'updateProduct':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $id = $input['id'] ?? 0;
        $stmt = $conn->prepare("UPDATE products SET product_name=?, sku=?, category=?, description=?, price=?, cost=?, stock_quantity=?, min_stock=?, status=? WHERE id=?");
        $status = $input['status'] ?? 'active';
        $stmt->bind_param("ssssddiisi", $input['product_name'], $input['sku'], $input['category'], $input['description'], $input['price'], $input['cost'], $input['stock_quantity'], $input['min_stock'], $status, $id);
        if ($stmt->execute()) {
            echo json_encode(['success' => true, 'message' => 'Product updated']);
        } else {
            echo json_encode(['success' => false, 'message' => 'Error updating product']);
        }
        $stmt->close();
        break;
        
    case 'deleteProduct':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $id = $input['id'] ?? 0;
        $stmt = $conn->prepare("DELETE FROM products WHERE id = ?");
        $stmt->bind_param("i", $id);
        if ($stmt->execute()) {
            echo json_encode(['success' => true, 'message' => 'Product deleted']);
        } else {
            echo json_encode(['success' => false, 'message' => 'Error deleting product']);
        }
        $stmt->close();
        break;
        
    case 'getLowStockProducts':
        $result = $conn->query("SELECT * FROM products WHERE stock_quantity <= min_stock AND stock_quantity > 0 AND status = 'active' ORDER BY stock_quantity ASC");
        $products = [];
        while ($row = $result->fetch_assoc()) $products[] = $row;
        echo json_encode(['success' => true, 'data' => $products]);
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
