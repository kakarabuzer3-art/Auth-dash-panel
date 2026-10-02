<?php
/**
 * Customers API
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

switch ($action) {
    case 'getCustomers':
        $search = $input['search'] ?? '';
        $where = !empty($search) ? "WHERE name LIKE '%$search%' OR email LIKE '%$search%' OR phone LIKE '%$search%'" : '';
        $result = $conn->query("SELECT * FROM customers $where ORDER BY created_at DESC");
        $customers = [];
        while ($row = $result->fetch_assoc()) $customers[] = $row;
        echo json_encode(['success' => true, 'data' => $customers]);
        break;
        
    case 'getCustomer':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("SELECT * FROM customers WHERE id = ?");
        $stmt->bind_param("i", $id);
        $stmt->execute();
        $result = $stmt->get_result();
        $customer = $result->num_rows > 0 ? $result->fetch_assoc() : null;
        $stmt->close();
        echo json_encode(['success' => true, 'data' => $customer]);
        break;
        
    case 'createCustomer':
        $name = $input['name'] ?? '';
        if (empty($name)) { echo json_encode(['success' => false, 'message' => 'Name required']); break; }
        $stmt = $conn->prepare("INSERT INTO customers (name, email, phone, address, city, state, zip_code, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')");
        $stmt->bind_param("sssssss", $name, $input['email'], $input['phone'], $input['address'], $input['city'], $input['state'], $input['zip_code']);
        if ($stmt->execute()) {
            echo json_encode(['success' => true, 'message' => 'Customer created', 'id' => $stmt->insert_id]);
        } else {
            echo json_encode(['success' => false, 'message' => 'Error creating customer']);
        }
        $stmt->close();
        break;
        
    case 'updateCustomer':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("UPDATE customers SET name=?, email=?, phone=?, address=?, city=?, state=?, zip_code=?, status=? WHERE id=?");
        $status = $input['status'] ?? 'active';
        $stmt->bind_param("ssssssssi", $input['name'], $input['email'], $input['phone'], $input['address'], $input['city'], $input['state'], $input['zip_code'], $status, $id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Customer updated']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'deleteCustomer':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("DELETE FROM customers WHERE id = ?");
        $stmt->bind_param("i", $id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Customer deleted']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
