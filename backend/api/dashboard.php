<?php
/**
 * Dashboard API - Statistics and Activity
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

function timeAgo($datetime) {
    $time = strtotime($datetime);
    $diff = time() - $time;
    if ($diff < 60) return 'Just now';
    if ($diff < 3600) return floor($diff / 60) . ' minutes ago';
    if ($diff < 86400) return floor($diff / 3600) . ' hours ago';
    if ($diff < 604800) return floor($diff / 86400) . ' days ago';
    return date('M j, Y', $time);
}

switch ($action) {
    case 'getStats':
        $stats = [];
        $result = $conn->query("SELECT COUNT(*) as count FROM users WHERE status = 'active'");
        $stats['total_users'] = $result->fetch_assoc()['count'];
        
        $result = $conn->query("SELECT COUNT(*) as count FROM products WHERE status = 'active'");
        $stats['total_products'] = $result->fetch_assoc()['count'];
        
        $result = $conn->query("SELECT COUNT(*) as count FROM sales WHERE status = 'completed'");
        $stats['total_sales'] = $result->fetch_assoc()['count'];
        
        $result = $conn->query("SELECT COALESCE(SUM(grand_total), 0) as total FROM sales WHERE status = 'completed'");
        $stats['total_revenue'] = floatval($result->fetch_assoc()['total']);
        
        $result = $conn->query("SELECT COALESCE(SUM(stock_quantity * cost), 0) as total FROM products WHERE status = 'active'");
        $stats['total_stock_value'] = floatval($result->fetch_assoc()['total']);
        
        $result = $conn->query("SELECT COUNT(*) as count FROM partners WHERE status = 'active'");
        $stats['active_partners'] = $result->fetch_assoc()['count'];
        
        $conn->query("UPDATE dashboard_stats SET stat_value = '" . date('Y-m-d H:i:s') . "', updated_at = NOW() WHERE stat_key = 'last_updated'");
        
        echo json_encode(['success' => true, 'data' => $stats]);
        break;
        
    case 'getActivity':
        $activity = [];
        
        $result = $conn->query("SELECT * FROM sales ORDER BY created_at DESC LIMIT 5");
        while ($row = $result->fetch_assoc()) {
            $activity[] = ['type' => 'success', 'icon' => 'fa-receipt', 'title' => 'Sale #' . $row['invoice_number'], 'time' => timeAgo($row['created_at'])];
        }
        
        $result = $conn->query("SELECT * FROM products ORDER BY created_at DESC LIMIT 3");
        while ($row = $result->fetch_assoc()) {
            $activity[] = ['type' => 'info', 'icon' => 'fa-box', 'title' => 'Product: ' . $row['product_name'], 'time' => timeAgo($row['created_at'])];
        }
        
        $result = $conn->query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 3");
        while ($row = $result->fetch_assoc()) {
            $activity[] = ['type' => $row['type'], 'icon' => 'fa-bell', 'title' => $row['title'], 'time' => timeAgo($row['created_at'])];
        }
        
        usort($activity, function($a, $b) { return strtotime($b['time']) - strtotime($a['time']); });
        $activity = array_slice($activity, 0, 10);
        
        echo json_encode(['success' => true, 'data' => $activity]);
        break;
        
    case 'getSalesChartData':
        $data = [];
        for ($i = 6; $i >= 0; $i--) {
            $date = date('Y-m-d', strtotime("-$i days"));
            $result = $conn->query("SELECT COALESCE(SUM(grand_total), 0) as total FROM sales WHERE DATE(created_at) = '$date' AND status = 'completed'");
            $row = $result->fetch_assoc();
            $data[] = floatval($row['total']);
        }
        echo json_encode(['success' => true, 'data' => $data]);
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
