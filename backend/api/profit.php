<?php
/**
 * Profit/Loss API
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
    case 'getProfitRecords':
        $result = $conn->query("SELECT pr.*, u.full_name as processed_by_name FROM profit_records pr LEFT JOIN users u ON pr.processed_by = u.id ORDER BY pr.record_date DESC");
        $records = [];
        while ($row = $result->fetch_assoc()) $records[] = $row;
        echo json_encode(['success' => true, 'data' => $records]);
        break;
        
    case 'getProfitRecord':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("SELECT pr.*, u.full_name as processed_by_name FROM profit_records pr LEFT JOIN users u ON pr.processed_by = u.id WHERE pr.id = ?");
        $stmt->bind_param("i", $id);
        $stmt->execute();
        $result = $stmt->get_result();
        $record = $result->num_rows > 0 ? $result->fetch_assoc() : null;
        $stmt->close();
        echo json_encode(['success' => true, 'data' => $record]);
        break;
        
    case 'createProfitRecord':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        
        $record_date = $input['record_date'] ?? date('Y-m-d');
        $total_profit = $input['total_profit'] ?? 0;
        $total_loss = $input['total_loss'] ?? 0;
        $description = $input['description'] ?? null;
        
        $net_amount = $total_profit - $total_loss;
        
        $payload = json_decode(base64_decode(explode('_', $token)[0]), true);
        $user_id = $payload['user_id'] ?? null;
        
        $stmt = $conn->prepare("INSERT INTO profit_records (record_date, total_profit, total_loss, net_amount, description, processed_by) VALUES (?, ?, ?, ?, ?, ?)");
        $stmt->bind_param("sdddsi", $record_date, $total_profit, $total_loss, $net_amount, $description, $user_id);
        
        if ($stmt->execute()) {
            echo json_encode(['success' => true, 'message' => 'Profit record created', 'id' => $stmt->insert_id]);
        } else {
            echo json_encode(['success' => false, 'message' => 'Error creating record']);
        }
        $stmt->close();
        break;
        
    case 'updateProfitRecord':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        
        $id = (int)($input['id'] ?? 0);
        $total_profit = $input['total_profit'] ?? 0;
        $total_loss = $input['total_loss'] ?? 0;
        $description = $input['description'] ?? null;
        $net_amount = $total_profit - $total_loss;
        
        $stmt = $conn->prepare("UPDATE profit_records SET total_profit=?, total_loss=?, net_amount=?, description=? WHERE id=?");
        $stmt->bind_param("dddsi", $total_profit, $total_loss, $net_amount, $description, $id);
        
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Record updated']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'deleteProfitRecord':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("DELETE FROM profit_records WHERE id = ?");
        $stmt->bind_param("i", $id);
        
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Record deleted']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'getProfitSummary':
        $result = $conn->query("SELECT SUM(total_profit) as total_profit, SUM(total_loss) as total_loss, SUM(net_amount) as net_amount FROM profit_records");
        $summary = $result->fetch_assoc();
        echo json_encode(['success' => true, 'data' => [
            'total_profit' => floatval($summary['total_profit'] ?? 0),
            'total_loss' => floatval($summary['total_loss'] ?? 0),
            'net_amount' => floatval($summary['net_amount'] ?? 0)
        ]]);
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
