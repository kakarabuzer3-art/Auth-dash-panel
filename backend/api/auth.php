<?php
/**
 * Authentication API
 * Project: SUB-Project (SUB-DB)
 * Handles user login, logout, and session management
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

// Include database configuration
require_once __DIR__ . '/../config/database.php';

$conn = getDBConnection();

// Handle preflight OPTIONS request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Get request body
$input = json_decode(file_get_contents('php://input'), true);
$action = $input['action'] ?? '';

// Generate JWT-like token (simple implementation)
function generateToken($userId, $username) {
    $payload = [
        'user_id' => $userId,
        'username' => $username,
        'iat' => time(),
        'exp' => time() + (8 * 3600) // 8 hours expiration
    ];
    return base64_encode(json_encode($payload)) . '_' . bin2hex(random_bytes(16));
}

// Verify token
function verifyToken($token) {
    try {
        $parts = explode('_', $token);
        if (count($parts) !== 2) return false;
        
        $payload = json_decode(base64_decode($parts[0]), true);
        if (!$payload || !isset($payload['exp']) || time() > $payload['exp']) {
            return false;
        }
        return $payload;
    } catch (Exception $e) {
        return false;
    }
}

// Handle actions
switch ($action) {
    case 'login':
        $username = $input['username'] ?? '';
        $password = $input['password'] ?? '';
        
        if (empty($username) || empty($password)) {
            echo json_encode(['success' => false, 'message' => 'Username and password required']);
            exit();
        }
        
        // Use global connection from database.php
        global $conn;
        
        $stmt = $conn->prepare("SELECT id, username, password, email, full_name, role, phone, status FROM users WHERE username = ? AND status = 'active'");
        $stmt->bind_param("s", $username);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows === 1) {
            $user = $result->fetch_assoc();
            
            if (password_verify($password, $user['password'])) {
                $token = generateToken($user['id'], $user['username']);
                
                // Update last login (optional)
                $updateStmt = $conn->prepare("UPDATE users SET updated_at = NOW() WHERE id = ?");
                $updateStmt->bind_param("i", $user['id']);
                $updateStmt->execute();
                
                echo json_encode([
                    'success' => true,
                    'token' => $token,
                    'user' => [
                        'id' => $user['id'],
                        'username' => $user['username'],
                        'email' => $user['email'],
                        'full_name' => $user['full_name'],
                        'role' => $user['role'],
                        'phone' => $user['phone']
                    ]
                ]);
            } else {
                echo json_encode(['success' => false, 'message' => 'Invalid username or password']);
            }
        } else {
            echo json_encode(['success' => false, 'message' => 'Invalid username or password']);
        }
        
        $stmt->close();
        break;
        
    case 'verify':
        $token = $input['token'] ?? '';
        
        if (empty($token)) {
            echo json_encode(['success' => false, 'message' => 'Token required']);
            exit();
        }
        
        $payload = verifyToken($token);
        
        if ($payload) {
            // Verify user still exists and is active
            global $conn;
            $stmt = $conn->prepare("SELECT id, username, full_name, role FROM users WHERE id = ? AND status = 'active'");
            $stmt->bind_param("i", $payload['user_id']);
            $stmt->execute();
            $result = $stmt->execute();
            
            if ($result->num_rows === 1) {
                echo json_encode(['success' => true, 'user' => $result->fetch_assoc()]);
            } else {
                echo json_encode(['success' => false, 'message' => 'User not found or inactive']);
            }
            $stmt->close();
        } else {
            echo json_encode(['success' => false, 'message' => 'Invalid or expired token']);
        }
        break;
        
    case 'logout':
        // In a simple implementation, we just clear the client-side token
        echo json_encode(['success' => true, 'message' => 'Logged out successfully']);
        break;
        
    case 'getCurrentUser':
        $token = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        $token = str_replace('Bearer ', '', $token);
        
        if (empty($token)) {
            echo json_encode(['success' => false, 'message' => 'Not authenticated']);
            exit();
        }
        
        $payload = verifyToken($token);
        if ($payload) {
            global $conn;
            $stmt = $conn->prepare("SELECT id, username, email, full_name, role, phone, status FROM users WHERE id = ?");
            $stmt->bind_param("i", $payload['user_id']);
            $stmt->execute();
            $result = $stmt->get_result();
            
            if ($result->num_rows === 1) {
                echo json_encode(['success' => true, 'user' => $result->fetch_assoc()]);
            } else {
                echo json_encode(['success' => false, 'message' => 'User not found']);
            }
            $stmt->close();
        } else {
            echo json_encode(['success' => false, 'message' => 'Invalid token']);
        }
        break;
        
    default:
        echo json_encode(['success' => false, 'message' => 'Invalid action']);
        break;
}

$conn->close();
?>
