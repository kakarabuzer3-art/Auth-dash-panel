<?php
/**
 * Expenses API
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

$token = $input['token'] ?? '';
$authenticated = verifyToken($token);

switch ($action) {
    case 'getExpenses':
        $search = $input['search'] ?? '';
        $where = !empty($search) ? "WHERE description LIKE '%$search%' OR expense_category LIKE '%$search%'" : '';
        $result = $conn->query("SELECT e.*, u.full_name as added_by_name FROM expenses e LEFT JOIN users u ON e.added_by = u.id $where ORDER BY e.expense_date DESC");
        $expenses = [];
        while ($row = $result->fetch_assoc()) $expenses[] = $row;
        $countResult = $conn->query("SELECT COUNT(*) as total FROM expenses $where");
        echo json_encode(['success' => true, 'data' => $expenses, 'total' => $countResult->fetch_assoc()['total']]);
        break;
        
    case 'getExpense':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("SELECT * FROM expenses WHERE id = ?");
        $stmt->bind_param("i", $id);
        $stmt->execute();
        $result = $stmt->get_result();
        $expense = $result->num_rows > 0 ? $result->fetch_assoc() : null;
        $stmt->close();
        echo json_encode(['success' => true, 'data' => $expense]);
        break;
        
    case 'createExpense':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $expense_category = $input['expense_category'] ?? '';
        if (empty($expense_category)) { echo json_encode(['success' => false, 'message' => 'Category required']); break; }
        $amount = $input['amount'] ?? 0;
        if ($amount <= 0) { echo json_encode(['success' => false, 'message' => 'Amount must be positive']); break; }
        $description = $input['description'] ?? null;
        $expense_date = $input['expense_date'] ?? date('Y-m-d');
        $payment_method = $input['payment_method'] ?? null;
        $receipt = $input['receipt'] ?? null;
        
        $payload = json_decode(base64_decode(explode('_', $token)[0]), true);
        $user_id = $payload['user_id'] ?? null;
        
        $stmt = $conn->prepare("INSERT INTO expenses (expense_category, description, amount, expense_date, payment_method, receipt, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
        $stmt->bind_param("ssssssi", $expense_category, $description, $amount, $expense_date, $payment_method, $receipt, $user_id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Expense recorded', 'id' => $stmt->insert_id]);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'updateExpense':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("UPDATE expenses SET expense_category=?, description=?, amount=?, expense_date=?, payment_method=?, receipt=? WHERE id=?");
        $stmt->bind_param("ssssssi", $input['expense_category'], $input['description'], $input['amount'], $input['expense_date'], $input['payment_method'], $input['receipt'], $id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Expense updated']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'deleteExpense':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("DELETE FROM expenses WHERE id = ?");
        $stmt->bind_param("i", $id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Expense deleted']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'getTotalExpenses':
        $result = $conn->query("SELECT COALESCE(SUM(amount), 0) as total FROM expenses");
        echo json_encode(['success' => true, 'data' => ['total' => floatval($result->fetch_assoc()['total'])]]);
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
