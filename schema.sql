-- Run this in your MySQL Workbench or phpMyAdmin

CREATE DATABASE IF NOT EXISTS gold_db;
USE gold_db;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    mobile VARCHAR(15) UNIQUE NOT NULL,
    address TEXT NOT NULL,
    password VARCHAR(255) NOT NULL,
    document_url VARCHAR(500) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category_id INT,
    image_url VARCHAR(500),
    price DECIMAL(10, 2) DEFAULT 0.00,
    stock_quantity INT DEFAULT 0,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS schemes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    metal_type VARCHAR(50) DEFAULT 'Gold',
    duration_months INT NOT NULL DEFAULT 11,
    tenure_months INT NOT NULL DEFAULT 11,
    bonus_months INT DEFAULT 1,
    min_monthly_installment DECIMAL(10, 2) DEFAULT 1000.00,
    max_monthly_installment DECIMAL(10, 2) DEFAULT 50000.00,
    bonus_text TEXT,
    terms_and_conditions TEXT,
    description TEXT,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    details TEXT,
    amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    weight_grams DECIMAL(10, 4) DEFAULT 0.0000,
    payment_id VARCHAR(100),
    status VARCHAR(20) DEFAULT 'SUCCESS',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metal_rates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    metal_type VARCHAR(50) NOT NULL,
    purity VARCHAR(50) NOT NULL,
    title VARCHAR(100) NOT NULL,
    buy_price_per_gram DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    sell_price_per_gram DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    is_active TINYINT(1) DEFAULT 1,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS enrollments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    enrollment_no VARCHAR(50) UNIQUE,
    receipt_no VARCHAR(50),
    user_id INT,
    customer_name VARCHAR(255) NOT NULL,
    customer_mobile VARCHAR(20) NOT NULL,
    customer_email VARCHAR(255),
    customer_address TEXT,
    pan_number VARCHAR(20),
    scheme_id INT,
    scheme_name VARCHAR(255) NOT NULL,
    metal_type VARCHAR(50) DEFAULT 'Gold',
    monthly_amount DECIMAL(10, 2) NOT NULL DEFAULT 1000.00,
    duration_months INT DEFAULT 12,
    bonus_amount DECIMAL(10, 2) DEFAULT 0.00,
    maturity_amount DECIMAL(10, 2) DEFAULT 0.00,
    nominee_name VARCHAR(255),
    nominee_relation VARCHAR(100),
    auto_debit TINYINT(1) DEFAULT 1,
    payment_method VARCHAR(50) DEFAULT 'UPI',
    payment_id VARCHAR(100),
    status VARCHAR(50) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);