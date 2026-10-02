<?php
/**
 * Notifications API
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
    case 'getNotifications':
        $user_id = $input['user_id'] ?? null;
        $unread_only = $input['unread_only'] ?? false;
        
        $where = '';
        if ($unread_only) $where = "WHERE is_read = 0";
        if ($user_id && $unread_only) $where = "WHERE is_read = 0 AND user_id = $user_id";
        elseif ($user_id) $where = "WHERE user_id = $user_id";
        
        $result = $conn->query("SELECT * FROM notifications $where ORDER BY created_at DESC LIMIT 50");
        $notifications = [];
        while ($row = $result->fetch_assoc()) $notifications[] = $row;
        
        echo json_encode(['success' => true, 'data' => $notifications]);
        break;
        
    case 'getUnreadCount':
        $user_id = $input['user_id'] ?? null;
        if ($user_id) {
            $result = $conn->query("SELECT COUNT(*) as count FROM notifications WHERE is_read = 0 AND user_id = $user_id");
        } else {
            $result = $conn->query("SELECT COUNT(*) as count FROM notifications WHERE is_read = 0");
        }
        $count = $result->fetch_assoc()['count'];
        echo json_encode(['success' => true, 'data' => ['count' => $count]]);
        break;
        
    case 'markAsRead':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("UPDATE notifications SET is_read = 1 WHERE id = ?");
        $stmt->bind_param("i", $id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Marked as read']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'markAllAsRead':
        if (!$authenticated) { echo json_encode(['success' => false, 'message' => 'Unauthorized']); break; }
        $user_id = $input['user_id'] ?? null;
        if ($user_id) {
            $stmt = $conn->prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0");
            $stmt->bind_param("i", $user_id);
        } else {
            $stmt = $conn->prepare("UPDATE notifications SET is_read = 1 WHERE is_read = 0");
        }
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'All marked as read']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'createNotification':
        $title = $input['title'] ?? '';
        $message = $input['message'] ?? '';
        $type = $input['type'] ?? 'info';
        $user_id = $input['user_id'] ?? null;
        
        if (empty($title) || empty($message)) {
            echo json_encode(['success' => false, 'message' => 'Title and message required']);
            break;
        }
        
        $stmt = $conn->prepare("INSERT INTO notifications (title, message, type, user_id) VALUES (?, ?, ?, ?)");
        $stmt->bind_param("sssi", $title, $message, $type, $user_id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Notification created', 'id' => $stmt->insert_id]);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
