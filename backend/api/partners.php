<?php
/**
 * Partners API - Partnership management and profit distribution
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
    case 'getPartners':
        $result = $conn->query("SELECT * FROM partners ORDER BY created_at DESC");
        $partners = [];
        while ($row = $result->fetch_assoc()) $partners[] = $row;
        echo json_encode(['success' => true, 'data' => $partners]);
        break;
        
    case 'getPartner':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("SELECT * FROM partners WHERE id = ?");
        $stmt->bind_param("i", $id);
        $stmt->execute();
        $result = $stmt->get_result();
        $partner = $result->num_rows > 0 ? $result->fetch_assoc() : null;
        $stmt->close();
        echo json_encode(['success' => true, 'data' => $partner]);
        break;
        
    case 'createPartner':
        $partner_name = $input['partner_name'] ?? '';
        if (empty($partner_name)) { echo json_encode(['success' => false, 'message' => 'Partner name required']); break; }
        $investment_amount = $input['investment_amount'] ?? 0;
        $investment_date = $input['investment_date'] ?? date('Y-m-d');
        $profit_share_percentage = $input['profit_share_percentage'] ?? 0;
        
        $stmt = $conn->prepare("INSERT INTO partners (partner_name, investment_amount, investment_date, profit_share_percentage, status) VALUES (?, ?, ?, ?, 'active')");
        $stmt->bind_param("sdds", $partner_name, $investment_amount, $investment_date, $profit_share_percentage);
        if ($stmt->execute()) {
            echo json_encode(['success' => true, 'message' => 'Partner added', 'id' => $stmt->insert_id]);
        } else {
            echo json_encode(['success' => false, 'message' => 'Error adding partner']);
        }
        $stmt->close();
        break;
        
    case 'updatePartner':
        $id = (int)($input['id'] ?? 0);
        $status = $input['status'] ?? 'active';
        $stmt = $conn->prepare("UPDATE partners SET partner_name=?, investment_amount=?, investment_date=?, profit_share_percentage=?, status=? WHERE id=?");
        $stmt->bind_param("sddssi", $input['partner_name'], $input['investment_amount'], $input['investment_date'], $input['profit_share_percentage'], $status, $id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Partner updated']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'deletePartner':
        $id = (int)($input['id'] ?? 0);
        $stmt = $conn->prepare("DELETE FROM partners WHERE id = ?");
        $stmt->bind_param("i", $id);
        if ($stmt->execute()) echo json_encode(['success' => true, 'message' => 'Partner deleted']);
        else echo json_encode(['success' => false, 'message' => 'Error']);
        $stmt->close();
        break;
        
    case 'calculateDistribution':
        $profit_amount = $input['profit_amount'] ?? 0;
        
        $result = $conn->query("SELECT * FROM partners WHERE status = 'active' ORDER BY investment_amount DESC");
        $partners = [];
        while ($row = $result->fetch_assoc()) $partners[] = $row;
        
        $total_investment = 0;
        foreach ($partners as $partner) $total_investment += floatval($partner['investment_amount']);
        
        $distributions = [];
        foreach ($partners as $partner) {
            $share_percentage = ($partner['investment_amount'] / $total_investment) * 100;
            $share_amount = ($profit_amount * $partner['investment_amount']) / $total_investment;
            $distributions[] = [
                'partner_id' => $partner['id'],
                'partner_name' => $partner['partner_name'],
                'investment' => floatval($partner['investment_amount']),
                'share_percentage' => round($share_percentage, 2),
                'share_amount' => round($share_amount, 2)
            ];
        }
        
        echo json_encode(['success' => true, 'data' => $distributions, 'total' => $profit_amount]);
        break;
        
    case 'recordProfitDistribution':
        $profit_record_id = $input['profit_record_id'] ?? 0;
        $distributions = $input['distributions'] ?? [];
        
        if (empty($distributions)) {
            echo json_encode(['success' => false, 'message' => 'No distributions provided']);
            break;
        }
        
        $conn->begin_transaction();
        try {
            foreach ($distributions as $dist) {
                $distStmt = $conn->prepare("INSERT INTO profit_distributions (profit_record_id, partner_id, distributed_amount, distribution_date, status) VALUES (?, ?, ?, CURDATE(), 'pending')");
                $distStmt->bind_param("iid", $profit_record_id, $dist['partner_id'], $dist['amount']);
                $distStmt->execute();
                $distStmt->close();
            }
            $conn->commit();
            echo json_encode(['success' => true, 'message' => 'Distributions recorded']);
        } catch (Exception $e) {
            $conn->rollback();
            echo json_encode(['success' => false, 'message' => 'Error recording distributions']);
        }
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
}
$conn->close();
?>
