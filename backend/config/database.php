<?php
/**
 * Database Configuration File
 * Project: SUB-Project (SUB-DB)
 * XAMPP phpMyAdmin Integration
 * 
 * Database Name: SUB-DB (matching project name)
 * Access: http://localhost/phpmyadmin/
 */

// Database configuration for XAMPP default settings
define('DB_SERVER', 'localhost');
define('DB_USERNAME', 'root');
define('DB_PASSWORD', '');  // XAMPP default: empty password
define('DB_NAME', 'SUB-DB');  // Project-matching database name

// Create database connection
$conn = new mysqli(DB_SERVER, DB_USERNAME, DB_PASSWORD, DB_NAME);

// Check connection
if ($conn->connect_error) {
    die("Connection failed: " . $conn->connect_error);
}

// Set charset to utf8mb4 for full Unicode support
$conn->set_charset("utf8mb4");

/**
 * Function to create database if not exists
 * Run this once to create SUB-DB in phpMyAdmin
 */
function createDatabaseIfNotExists() {
    global $conn;
    
    $tempConn = new mysqli(DB_SERVER, DB_USERNAME, DB_PASSWORD);
    
    if ($tempConn->connect_error) {
        die("Connection failed: " . $tempConn->connect_error);
    }
    
    $sql = "CREATE DATABASE IF NOT EXISTS `" . DB_NAME . "` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci";
    
    if ($tempConn->query($sql) === TRUE) {
        echo "Database SUB-DB created successfully or already exists.<br>";
    } else {
        echo "Error creating database: " . $tempConn->error . "<br>";
    }
    
    $tempConn->close();
}


/**
 * Function to create all required tables
 */
function createTables() {
    global $conn;
    
    $tables = array();
    
    // Table: Users (Admin/Staff)
    $tables[] = "CREATE TABLE IF NOT EXISTS `users` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `username` VARCHAR(50) NOT NULL UNIQUE,
        `password` VARCHAR(255) NOT NULL,
        `email` VARCHAR(100) NOT NULL,
        `full_name` VARCHAR(100) NOT NULL,
        `role` ENUM('admin','manager','staff','user') DEFAULT 'user',
        `phone` VARCHAR(20) DEFAULT NULL,
        `status` ENUM('active','inactive','blocked') DEFAULT 'active',
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Dashboard Stats
    $tables[] = "CREATE TABLE IF NOT EXISTS `dashboard_stats` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `stat_key` VARCHAR(50) NOT NULL UNIQUE,
        `stat_value` VARCHAR(255) NOT NULL,
        `stat_type` ENUM('number','text','date','currency') DEFAULT 'number',
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Products
    $tables[] = "CREATE TABLE IF NOT EXISTS `products` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,


    // Table: Stock Transactions
    $tables[] = "CREATE TABLE IF NOT EXISTS `stock_transactions` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `product_id` INT(11) UNSIGNED NOT NULL,
        `transaction_type` ENUM('in','out','adjustment','transfer') NOT NULL,
        `quantity` INT(11) NOT NULL,
        `reference` VARCHAR(100) DEFAULT NULL,
        `notes` TEXT DEFAULT NULL,
        `user_id` INT(11) UNSIGNED DEFAULT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Sales
    $tables[] = "CREATE TABLE IF NOT EXISTS `sales` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `invoice_number` VARCHAR(50) NOT NULL UNIQUE,
        `customer_name` VARCHAR(100) DEFAULT NULL,
        `customer_phone` VARCHAR(20) DEFAULT NULL,
        `total_amount` DECIMAL(10,2) NOT NULL,
        `discount` DECIMAL(10,2) DEFAULT 0.00,
        `tax` DECIMAL(10,2) DEFAULT 0.00,
        `grand_total` DECIMAL(10,2) NOT NULL,
        `payment_method` ENUM('cash','card','online','bank_transfer') DEFAULT 'cash',
        `status` ENUM('pending','completed','cancelled','refunded') DEFAULT 'completed',
        `created_by` INT(11) UNSIGNED DEFAULT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    

    // Table: Partners (for profit sharing)
    $tables[] = "CREATE TABLE IF NOT EXISTS `partners` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `partner_name` VARCHAR(100) NOT NULL,
        `investment_amount` DECIMAL(15,2) NOT NULL,
        `investment_date` DATE NOT NULL,
        `profit_share_percentage` DECIMAL(5,2) NOT NULL,
        `status` ENUM('active','inactive','paid_out') DEFAULT 'active',
        `notes` TEXT DEFAULT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Profit Records
    $tables[] = "CREATE TABLE IF NOT EXISTS `profit_records` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `record_date` DATE NOT NULL,
        `total_profit` DECIMAL(15,2) NOT NULL,
        `total_loss` DECIMAL(15,2) DEFAULT 0.00,
        `net_amount` DECIMAL(15,2) NOT NULL,
        `description` TEXT DEFAULT NULL,
        `processed_by` INT(11) UNSIGNED DEFAULT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (`processed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Profit Distributions
    $tables[] = "CREATE TABLE IF NOT EXISTS `profit_distributions` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `profit_record_id` INT(11) UNSIGNED NOT NULL,
        `partner_id` INT(11) UNSIGNED NOT NULL,


/**
 * Function to insert default admin user
 */
function createDefaultAdmin() {
    global $conn;
    
    $checkSql = "SELECT id FROM users WHERE username = 'admin'";
    $checkResult = $conn->query($checkSql);
    
    if ($checkResult->num_rows === 0) {
        $hashedPassword = password_hash('admin123', PASSWORD_DEFAULT);
        
        $sql = "INSERT INTO users (username, password, email, full_name, role, phone, status) 
                VALUES ('admin', '$hashedPassword', 'admin@sub-project.local', 'System Administrator', 'admin', '000-000-0000', 'active')";
        
        if ($conn->query($sql) === TRUE) {
            echo "Default admin user created.<br>";
            echo "Login: admin / admin123<br>";
        } else {
            echo "Error creating admin: " . $conn->error . "<br>";
        }
    } else {
        echo "Admin user already exists.<br>";
    }
}

/**
 * Function to insert sample dashboard stats
 */
function createSampleStats() {
    global $conn;
    
    $stats = array(
        array('total_users', '1', 'number'),
        array('total_products', '0', 'number'),
        array('total_sales', '0', 'number'),
        array('total_revenue', '0.00', 'currency'),
        array('total_stock_value', '0.00', 'currency'),
        array('active_partners', '0', 'number'),
        array('last_updated', date('Y-m-d H:i:s'), 'datetime')
    );
    
    foreach ($stats as $stat) {
        $sql = "INSERT IGNORE INTO dashboard_stats (stat_key, stat_value, stat_type) 
                VALUES ('" . $stat[0] . "', '" . $stat[1] . "', '" . $stat[2] . "')";
        $conn->query($sql);
    }
    
    echo "Sample dashboard stats initialized.<br>";
}

// Handle initialization requests
if (isset($_GET['action'])) {
    if ($_GET['action'] == 'create_db') {
        createDatabaseIfNotExists();
    } elseif ($_GET['action'] == 'create_tables') {
        createTables();
    } elseif ($_GET['action'] == 'setup') {
        createDatabaseIfNotExists();
        createTables();
        createDefaultAdmin();
        createSampleStats();
        echo "<br>=== SETUP COMPLETE ===<br>";
        echo "Database: SUB-DB<br>";
        echo "Admin Login: admin / admin123<br>";
        echo "PhpMyAdmin: http://localhost/phpmyadmin/<br>";
    }
}
?>

        `distributed_amount` DECIMAL(15,2) NOT NULL,
        `distribution_date` DATE NOT NULL,
        `payment_method` VARCHAR(50) DEFAULT NULL,
        `receipt_number` VARCHAR(50) DEFAULT NULL,
        `status` ENUM('pending','paid','partial') DEFAULT 'pending',
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (`profit_record_id`) REFERENCES `profit_records`(`id`) ON DELETE CASCADE,
        FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Expenses
    $tables[] = "CREATE TABLE IF NOT EXISTS `expenses` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `expense_category` VARCHAR(50) NOT NULL,
        `description` TEXT DEFAULT NULL,
        `amount` DECIMAL(10,2) NOT NULL,
        `expense_date` DATE NOT NULL,
        `payment_method` VARCHAR(50) DEFAULT NULL,
        `receipt` VARCHAR(255) DEFAULT NULL,
        `added_by` INT(11) UNSIGNED DEFAULT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Notifications
    $tables[] = "CREATE TABLE IF NOT EXISTS `notifications` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `title` VARCHAR(100) NOT NULL,
        `message` TEXT NOT NULL,
        `type` ENUM('info','success','warning','error') DEFAULT 'info',
        `user_id` INT(11) UNSIGNED DEFAULT NULL,
        `is_read` TINYINT(1) DEFAULT 0,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    foreach ($tables as $tableSql) {
        if ($conn->query($tableSql) === TRUE) {
            echo "Table created successfully.<br>";
        } else {
            echo "Error creating table: " . $conn->error . "<br>";
        }
    }
}

    // Table: Sale Items
    $tables[] = "CREATE TABLE IF NOT EXISTS `sale_items` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `sale_id` INT(11) UNSIGNED NOT NULL,
        `product_id` INT(11) UNSIGNED NOT NULL,
        `quantity` INT(11) NOT NULL,
        `unit_price` DECIMAL(10,2) NOT NULL,
        `discount` DECIMAL(10,2) DEFAULT 0.00,
        `total` DECIMAL(10,2) NOT NULL,
        FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON DELETE CASCADE,
        FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    // Table: Customers
    $tables[] = "CREATE TABLE IF NOT EXISTS `customers` (
        `id` INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `name` VARCHAR(100) NOT NULL,
        `email` VARCHAR(100) DEFAULT NULL,
        `phone` VARCHAR(20) DEFAULT NULL,
        `address` TEXT DEFAULT NULL,
        `city` VARCHAR(50) DEFAULT NULL,
        `state` VARCHAR(50) DEFAULT NULL,
        `zip_code` VARCHAR(20) DEFAULT NULL,
        `status` ENUM('active','inactive') DEFAULT 'active',
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";

        `product_name` VARCHAR(100) NOT NULL,
        `sku` VARCHAR(50) DEFAULT NULL,
        `category` VARCHAR(50) DEFAULT NULL,
        `description` TEXT DEFAULT NULL,
        `price` DECIMAL(10,2) DEFAULT 0.00,
        `cost` DECIMAL(10,2) DEFAULT 0.00,
        `stock_quantity` INT(11) DEFAULT 0,
        `min_stock` INT(11) DEFAULT 10,
        `image` VARCHAR(255) DEFAULT NULL,
        `status` ENUM('active','inactive','out_of_stock') DEFAULT 'active',
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
    
    foreach ($tables as $tableSql) {
        if ($conn->query($tableSql) === TRUE) {
            echo "Table created successfully.<br>";
        } else {
            echo "Error creating table: " . $conn->error . "<br>";
        }
    }
}

