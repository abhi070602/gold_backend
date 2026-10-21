require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Razorpay = require('razorpay');

// Fallback: Manually parse .env if process.env.RAZORPAY_KEY_ID is missing
if (!process.env.RAZORPAY_KEY_ID) {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        try {
            const envContent = fs.readFileSync(envPath, 'utf8');
            envContent.split(/\r?\n/).forEach(line => {
                const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
                if (match) {
                    const key = match[1];
                    let value = (match[2] || '').trim();
                    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
                    process.env[key] = value;
                }
            });
        } catch (e) {}
    }
}

const app = express();
app.use(cors());
app.use(express.json()); // To parse JSON bodies

// --- Razorpay Payment Gateway Initialization ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_TD2r6IhGkKFSPW';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'z6d2TubfHUIBelRauVOwewHC';

let razorpay = null;
try {
    razorpay = new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
    });
    console.log('[Razorpay] Payment Gateway initialized with Key ID:', RAZORPAY_KEY_ID);
} catch (rzpErr) {
    console.warn('[Razorpay] Initialization notice:', rzpErr.message);
}

// --- 1. MySQL Database Connection ---
// const db = mysql.createConnection({
//     host: 'localhost',
//     user: 'root',
//     password: '',
//     database: 'gold_db' // Fresh, dedicated database for this app
// });

//here i use Railway database credentials
// ✅ Support Railway MySQL Environment Variables + Local fallback:
const db = mysql.createPool(
    process.env.MYSQL_URL || process.env.DATABASE_URL || {
        host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
        user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
        password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
        database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'gold_db',
        port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    }
);


db.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed: ' + err.stack);
        return;
    }
    console.log('Connected to MySQL database via Pool');
    connection.release();

    // Auto-migrations: Ensure 'status' column in 'users'
    const addStatusCol = "ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'PENDING'";
    db.query(addStatusCol, () => {
        db.query("UPDATE users SET status = 'PENDING' WHERE status IS NULL OR status = ''", () => {});
    });

    // Ensure demo user exists in users table with APPROVED status
    const seedDemoUser = `
        INSERT INTO users (name, email, mobile, address, password, status)
        VALUES ('Demo Sovereign', 'demo@gmail.com', '9876543210', 'Boutique Suite, Mumbai', 'Demo123', 'APPROVED')
        ON DUPLICATE KEY UPDATE status = 'APPROVED'
    `;
    db.query(seedDemoUser, () => {});

    // Auto-migrations for 'schemes' table
    const alterSchemesQueries = [
        "ALTER TABLE schemes ADD COLUMN metal_type VARCHAR(50) DEFAULT 'Gold'",
        "ALTER TABLE schemes ADD COLUMN duration_months INT DEFAULT 11",
        "ALTER TABLE schemes ADD COLUMN tenure_months INT DEFAULT 11",
        "ALTER TABLE schemes ADD COLUMN bonus_months INT DEFAULT 1",
        "ALTER TABLE schemes ADD COLUMN min_monthly_installment DECIMAL(10, 2) DEFAULT 1000.00",
        "ALTER TABLE schemes ADD COLUMN max_monthly_installment DECIMAL(10, 2) DEFAULT 50000.00",
        "ALTER TABLE schemes ADD COLUMN terms_and_conditions TEXT",
        "ALTER TABLE schemes ADD COLUMN is_active TINYINT(1) DEFAULT 1"
    ];
    alterSchemesQueries.forEach(q => {
        db.query(q, () => {});
    });

    // Auto-create 'categories' table
    const createCategoriesTable = `
        CREATE TABLE IF NOT EXISTS categories (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) UNIQUE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // Auto-create 'products' table
    const createProductsTable = `
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
    `;

    // Auto-create 'transactions' table for user portfolio history
    const createTransactionsTable = `
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
    `;

    // Auto-create 'metal_rates' table
    const createMetalRatesTable = `
        CREATE TABLE IF NOT EXISTS metal_rates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            gold_rate DECIMAL(10, 2) DEFAULT 7500.00,
            silver_rate DECIMAL(10, 2) DEFAULT 90.00,
            gold_change DECIMAL(5, 2) DEFAULT 0.00,
            silver_change DECIMAL(5, 2) DEFAULT 0.00,
            admin_markup DECIMAL(5, 2) DEFAULT 0.00,
            updated_by VARCHAR(100) DEFAULT 'ADMIN',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // Auto-create 'enrollments' table for Scheme Enrollment Form Data
    const createEnrollmentsTable = `
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
    `;

    db.query(createCategoriesTable, () => {
        db.query("INSERT IGNORE INTO categories (id, name, description) VALUES (1, 'Gold', 'Pure gold jewellery'), (2, 'Silver', 'Sterling and fine silver items')", () => {
            db.query(createProductsTable, () => {
                db.query("SELECT COUNT(*) as count FROM products", (err, rows) => {
                    if (!err && rows[0].count === 0) {
                        const defaultProducts = [
                            ['Luxe Pendant', 1, 'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=600&q=80', 970.00, 15, 'Handcrafted 24K Gold Pendant'],
                            ['Royal Gold Necklace', 1, 'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&w=600&q=80', 2450.00, 8, 'Traditional 22K Gold Necklace'],
                            ['Sterling Silver Ring', 2, 'https://images.unsplash.com/photo-1603561591411-07134e71a2a9?auto=format&fit=crop&w=600&q=80', 180.00, 25, '925 Sterling Silver Designer Ring'],
                            ['Silver Antique Bangles', 2, 'https://images.unsplash.com/photo-1611591475270-1f19d2425026?auto=format&fit=crop&w=600&q=80', 450.00, 12, 'Fine Silver Antique Finish Bangles']
                        ];
                        defaultProducts.forEach(p => {
                            db.query("INSERT INTO products (name, category_id, image_url, price, stock_quantity, description) VALUES (?, ?, ?, ?, ?, ?)", p, () => {});
                        });
                    }
                });
                db.query(createTransactionsTable, () => {
                    db.query(createMetalRatesTable, () => {
                        db.query(createEnrollmentsTable, () => {
                            console.log("Database tables, categories, products, and enrollments verified.");
                        });
                    });
                });
            });
        });
    });
});

// --- 2. Multer Setup for Document & Product Uploads ---
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: function (req, file, cb) {
        cb(null, 'file_' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });
app.use('/uploads', express.static('uploads'));

const JWT_SECRET = "YOUR_SUPER_SECRET_KEY_12345";

// --- 3. API ROUTES ---

// Health check
app.get('/', (req, res) => {
    res.send("Welcome! The Node.js GoldApp Backend is running successfully.");
});

// A. Signup (User starts with PENDING status)
app.post('/api/auth/signup', upload.single('legalDocument'), (req, res) => {
    const { name, email, mobile, address, password } = req.body;
    const documentUrl = req.file ? `/uploads/${req.file.filename}` : '';

    if (!name || !email || !password || !mobile) {
        return res.status(400).json({ message: "Name, email, mobile, and password are required." });
    }

    const query = 'INSERT INTO users (name, email, mobile, address, password, document_url, status) VALUES (?, ?, ?, ?, ?, ?, ?)';

    db.query(query, [name, email, mobile, address, password, documentUrl, 'PENDING'], (err, result) => {
        if (err) {
            console.error(err);
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: "Email or mobile number already exists." });
            }
            return res.status(500).json({ message: "Database error." });
        }

        const userId = result.insertId;
        const userPayload = {
            id: userId,
            name: name,
            email: email,
            mobile: mobile,
            address: address,
            documentUrl: documentUrl,
            status: 'PENDING'
        };

        res.status(200).json({
            message: "Registration submitted successfully! Please wait for admin approval before logging in.",
            user: userPayload
        });
    });
});

// B. Login Endpoint with JWT Authentication & Database Verification
const handleLoginRequest = (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Email and password are required."
        });
    }

    const cleanEmail = email.toString().trim();
    const cleanPassword = password.toString();

    // Query MySQL users table case-insensitively by email
    const query = 'SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(?)';
    db.query(query, [cleanEmail], (err, results) => {
        if (err) {
            console.error("Login DB error:", err);
            return res.status(500).json({
                success: false,
                message: "Database error during authentication."
            });
        }

        if (results.length > 0) {
            const user = results[0];

            // Verify password against database password
            const passwordMatches = (user.password === cleanPassword) || (user.password === cleanPassword.trim());
            if (!passwordMatches) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid email or password."
                });
            }

            const userStatus = (user.status || 'APPROVED').toUpperCase();

            // Strict check on account status
            if (userStatus === 'REJECTED') {
                return res.status(403).json({
                    success: false,
                    message: "Your account application has been rejected by the administrator."
                });
            }

            if (userStatus === 'PENDING') {
                return res.status(403).json({
                    success: false,
                    message: "Access Denied: Your account is pending admin approval. Please wait for an administrator to approve your account before logging in."
                });
            }

            // Dynamically calculate genuine holdings from MySQL transactions table
            db.query('SELECT type, amount, weight_grams, status FROM transactions WHERE user_id = ?', [user.id], (txErr, txRows) => {
                let goldGrams = 0.0;
                let silverGrams = 0.0;
                let totalInvested = 0.0;

                if (!txErr && txRows) {
                    txRows.forEach(tx => {
                        const statusUpper = (tx.status || 'COMPLETED').toUpperCase();
                        if (statusUpper === 'FAILED' || statusUpper === 'CANCELLED' || statusUpper === 'REJECTED') return;
                        const amt = parseFloat(tx.amount || 0);
                        const w = parseFloat(tx.weight_grams || 0);
                        const typeUpper = (tx.type || '').toUpperCase();

                        if (typeUpper.includes('BUY_GOLD') || typeUpper === 'GOLD_BUY' || typeUpper === 'BUY GOLD') {
                            goldGrams += w;
                            totalInvested += amt;
                        } else if (typeUpper.includes('SELL_GOLD') || typeUpper === 'GOLD_SELL' || typeUpper === 'SELL GOLD') {
                            goldGrams -= w;
                            totalInvested -= amt;
                        } else if (typeUpper.includes('BUY_SILVER') || typeUpper === 'SILVER_BUY' || typeUpper === 'BUY SILVER') {
                            silverGrams += w;
                            totalInvested += amt;
                        } else if (typeUpper.includes('SELL_SILVER') || typeUpper === 'SILVER_SELL' || typeUpper === 'SILVER SELL') {
                            silverGrams -= w;
                            totalInvested -= amt;
                        } else {
                            totalInvested += amt;
                        }
                    });
                }

                const userPayload = {
                    id: user.id.toString(),
                    name: user.name,
                    email: user.email,
                    mobile: user.mobile,
                    phoneNumber: user.mobile,
                    phone_number: user.mobile,
                    address: user.address,
                    documentUrl: user.document_url,
                    status: userStatus,
                    goldBalance: Math.max(0, goldGrams),
                    silverBalance: Math.max(0, silverGrams),
                    totalVaultValueINR: Math.max(0, totalInvested),
                    tier: 'VIP Sovereign',
                    kycStatus: userStatus === 'APPROVED' ? 'VERIFIED' : 'PENDING'
                };

                // Sign JWT authentication token
                const token = jwt.sign(userPayload, JWT_SECRET, { expiresIn: '30d' });
                const refreshToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '60d' });

                res.status(200).json({
                    success: true,
                    message: "Login successful",
                    token: token,
                    refreshToken: refreshToken,
                    user: userPayload,
                    data: userPayload
                });
            });
        } else {
            res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }
    });
};

app.post('/api/auth/login', handleLoginRequest);
app.post('/api/login', handleLoginRequest);

// Middleware to verify JWT authentication token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: "No authentication token provided." });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ success: false, message: "Invalid or expired token." });
        }
        req.user = decoded;
        next();
    });
};

// Helper to fetch user profile with genuine balances from database
const sendUserProfile = (userId, res, fallbackUser) => {
    const query = 'SELECT id, name, email, mobile, address, document_url, status, created_at FROM users WHERE id = ?';
    db.query(query, [userId], (err, results) => {
        if (err || results.length === 0) {
            return res.status(200).json({ success: true, data: fallbackUser });
        }
        const user = results[0];
        const userStatus = (user.status || 'APPROVED').toUpperCase();

        db.query('SELECT type, amount, weight_grams, status FROM transactions WHERE user_id = ?', [user.id], (txErr, txRows) => {
            let goldGrams = 0.0;
            let silverGrams = 0.0;
            let totalInvested = 0.0;

            if (!txErr && txRows) {
                txRows.forEach(tx => {
                    const statusUpper = (tx.status || 'COMPLETED').toUpperCase();
                    if (statusUpper === 'FAILED' || statusUpper === 'CANCELLED' || statusUpper === 'REJECTED') return;
                    const amt = parseFloat(tx.amount || 0);
                    const w = parseFloat(tx.weight_grams || 0);
                    const typeUpper = (tx.type || '').toUpperCase();

                    if (typeUpper.includes('BUY_GOLD') || typeUpper === 'GOLD_BUY' || typeUpper === 'BUY GOLD') {
                        goldGrams += w;
                        totalInvested += amt;
                    } else if (typeUpper.includes('SELL_GOLD') || typeUpper === 'GOLD_SELL' || typeUpper === 'SELL GOLD') {
                        goldGrams -= w;
                        totalInvested -= amt;
                    } else if (typeUpper.includes('BUY_SILVER') || typeUpper === 'SILVER_BUY' || typeUpper === 'BUY SILVER') {
                        silverGrams += w;
                        totalInvested += amt;
                    } else if (typeUpper.includes('SELL_SILVER') || typeUpper === 'SILVER_SELL' || typeUpper === 'SILVER SELL') {
                        silverGrams -= w;
                        totalInvested -= amt;
                    } else {
                        totalInvested += amt;
                    }
                });
            }

            const profile = {
                id: user.id.toString(),
                name: user.name,
                email: user.email,
                mobile: user.mobile,
                phoneNumber: user.mobile,
                phone_number: user.mobile,
                address: user.address,
                documentUrl: user.document_url,
                status: userStatus,
                goldBalance: Math.max(0, goldGrams),
                silverBalance: Math.max(0, silverGrams),
                totalVaultValueINR: Math.max(0, totalInvested),
                tier: 'VIP Sovereign',
                kycStatus: userStatus === 'APPROVED' ? 'VERIFIED' : 'PENDING'
            };
            res.status(200).json({ success: true, data: profile });
        });
    });
};

// C. Verify JWT and Fetch Current User Profile
app.get('/api/auth/me', authenticateToken, (req, res) => {
    sendUserProfile(req.user.id, res, req.user);
});
app.get('/api/me', authenticateToken, (req, res) => {
    sendUserProfile(req.user.id, res, req.user);
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
    res.status(200).json({ success: true, message: "Logged out successfully." });
});
app.post('/api/logout', (req, res) => {
    res.status(200).json({ success: true, message: "Logged out successfully." });
});

// C. Fetch All Users (for Admin Dashboard)
app.get('/api/users', (req, res) => {
    const query = 'SELECT id, name, email, mobile, address, document_url AS documentUrl, status, created_at FROM users';
    db.query(query, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(200).json(results);
    });
});

// Approve User
app.put('/api/users/:id/approve', (req, res) => {
    const userId = req.params.id;
    db.query("UPDATE users SET status = 'APPROVED' WHERE id = ?", [userId], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(200).json({ message: "User approved successfully" });
    });
});

// Reject User
app.put('/api/users/:id/reject', (req, res) => {
    const userId = req.params.id;
    db.query("UPDATE users SET status = 'REJECTED' WHERE id = ?", [userId], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(200).json({ message: "User rejected successfully" });
    });
});

// Update User Status
app.put('/api/users/:id/status', (req, res) => {
    const userId = req.params.id;
    const { status } = req.body;
    if (!status) {
        return res.status(400).json({ message: "Status is required." });
    }
    db.query("UPDATE users SET status = ? WHERE id = ?", [status, userId], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(200).json({ message: `User status updated to ${status}` });
    });
});

// --- D. TRANSACTIONS & PORTFOLIO ENDPOINTS ---
app.post('/api/transactions', (req, res) => {
    const { userId, user_id, type, title, details, amount, weightGrams, weight_grams, paymentId, payment_id, status } = req.body;
    const finalUserId = userId || user_id;
    const finalType = type || 'PURCHASE';
    const finalTitle = title || 'Transaction';
    const finalDetails = details || '';
    const finalAmount = amount || 0.00;
    const finalWeight = weightGrams || weight_grams || 0.0000;
    const finalPaymentId = paymentId || payment_id || '';
    const finalStatus = status || 'SUCCESS';

    if (!finalUserId) {
        return res.status(400).json({ message: "User ID is required." });
    }

    const query = 'INSERT INTO transactions (user_id, type, title, details, amount, weight_grams, payment_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    db.query(query, [finalUserId, finalType, finalTitle, finalDetails, finalAmount, finalWeight, finalPaymentId, finalStatus], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(201).json({
            id: result.insertId,
            userId: finalUserId,
            type: finalType,
            title: finalTitle,
            details: finalDetails,
            amount: finalAmount,
            weightGrams: finalWeight,
            paymentId: finalPaymentId,
            status: finalStatus
        });
    });
});

// --- Razorpay Payment Gateway Endpoints ---

// Get active Razorpay configuration
app.get(['/api/payment/razorpay/config', '/api/razorpay/config'], (req, res) => {
    res.status(200).json({
        success: true,
        keyId: RAZORPAY_KEY_ID,
        currency: 'INR',
        companyName: 'Chintamani Jewellers',
        themeColor: '#D4AF37'
    });
});

// Create Razorpay Order
app.post(['/api/payment/create-order', '/api/razorpay/create-order', '/api/payment/razorpay/order'], async (req, res) => {
    try {
        const { amount, currency = 'INR', receipt, notes, purpose } = req.body;
        const numericAmount = parseFloat(amount || 0);

        if (numericAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid payment amount.' });
        }

        const amountInPaise = Math.round(numericAmount * 100);
        const receiptId = receipt || `rcpt_${Date.now().toString().slice(-8)}`;

        // If real Razorpay key is configured and valid, call official Razorpay API
        const isLiveKey = RAZORPAY_KEY_ID && !RAZORPAY_KEY_ID.includes('Chintamani') && !RAZORPAY_KEY_ID.includes('Mocked');
        if (isLiveKey && razorpay) {
            try {
                const order = await razorpay.orders.create({
                    amount: amountInPaise,
                    currency,
                    receipt: receiptId,
                    notes: {
                        purpose: purpose || 'Bullion / Scheme Payment',
                        ...(notes || {})
                    }
                });

                return res.status(200).json({
                    success: true,
                    orderId: order.id,
                    amount: order.amount,
                    currency: order.currency,
                    keyId: RAZORPAY_KEY_ID,
                    receipt: order.receipt
                });
            } catch (apiErr) {
                console.warn('[Razorpay API Notice]:', apiErr?.error?.description || apiErr?.message);
            }
        }

        // Sandbox Order for test / development environments
        const sandboxOrderId = `order_test_${Date.now().toString().slice(-8)}_${Math.floor(1000 + Math.random() * 9000)}`;
        res.status(200).json({
            success: true,
            orderId: sandboxOrderId,
            amount: amountInPaise,
            currency: 'INR',
            keyId: RAZORPAY_KEY_ID,
            receipt: receiptId,
            sandbox: true,
            notes: notes || {}
        });
    } catch (error) {
        console.error('Error creating Razorpay order:', error);
        res.status(500).json({ success: false, message: 'Failed to create payment order' });
    }
});

// Verify Razorpay Payment Signature
app.post(['/api/payment/verify', '/api/razorpay/verify', '/api/payment/razorpay/verify'], (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            orderId,
            paymentId,
            signature
        } = req.body;

        const finalOrderId = razorpay_order_id || orderId;
        const finalPaymentId = razorpay_payment_id || paymentId;
        const finalSignature = razorpay_signature || signature;

        if (!finalOrderId || !finalPaymentId) {
            return res.status(400).json({ success: false, message: 'Order ID and Payment ID are required.' });
        }

        // Verify cryptographic signature if signature is provided and not sandbox
        let isValid = true;
        if (finalSignature && !finalOrderId.startsWith('order_test_')) {
            const hmac = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
            hmac.update(`${finalOrderId}|${finalPaymentId}`);
            const generatedSignature = hmac.digest('hex');
            isValid = (generatedSignature === finalSignature);
        }

        if (!isValid) {
            return res.status(400).json({ success: false, message: 'Payment verification failed: Invalid Razorpay signature.' });
        }

        console.log(`[Razorpay Verified] Order ${finalOrderId} -> Payment ${finalPaymentId}`);

        res.status(200).json({
            success: true,
            verified: true,
            paymentId: finalPaymentId,
            orderId: finalOrderId,
            message: 'Razorpay payment verified successfully.'
        });
    } catch (error) {
        console.error('Error verifying Razorpay payment:', error);
        res.status(500).json({ success: false, message: 'Payment verification error.' });
    }
});

// Alias: Purchases Endpoint (Used by Buy Gold / Silver Bullion)
app.post(['/api/purchases/create', '/api/purchases'], (req, res) => {
    const { userId, user_id, metal, grams, amount, paymentMethod } = req.body;
    const finalUserId = userId || user_id || (req.user && req.user.id) || 1;
    const isSilver = String(metal || '').toLowerCase().includes('silver');
    const finalType = isSilver ? 'BUY_SILVER' : 'BUY_GOLD';
    const finalTitle = isSilver ? 'Physical 999 Fine Pure Silver Bullion' : '24K (999.9) Pure Gold Bullion';
    const finalWeight = parseFloat(grams || 0);
    const finalAmount = parseFloat(amount || 0);
    const paymentId = `PAY_CJ_${Date.now().toString().slice(-8)}`;

    const query = 'INSERT INTO transactions (user_id, type, title, details, amount, weight_grams, payment_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    db.query(query, [finalUserId, finalType, finalTitle, JSON.stringify({ paymentMethod }), finalAmount, finalWeight, paymentId, 'SUCCESS'], (err, result) => {
        if (err) {
            console.error("Error creating purchase:", err);
            return res.status(500).json({ success: false, message: "Database error." });
        }
        res.status(201).json({
            success: true,
            id: result.insertId,
            type: finalType,
            title: finalTitle,
            amount: finalAmount,
            weightGrams: finalWeight,
            paymentId,
            status: 'SUCCESS'
        });
    });
});

// Scheme Enrollment Endpoint: Persist all enrollment form data into database
app.post(['/api/enrollments', '/api/schemes/enroll'], (req, res) => {
    const {
        userId,
        user_id,
        fullName,
        customerName,
        customer_name,
        mobileNumber,
        customerMobile,
        customer_mobile,
        emailAddress,
        customerEmail,
        customer_email,
        addressText,
        customerAddress,
        customer_address,
        panNumber,
        pan_number,
        schemeId,
        scheme_id,
        schemeName,
        scheme_name,
        metalType,
        metal_type,
        monthlyAmount,
        monthly_amount,
        durationMonths,
        duration_months,
        bonusAmount,
        bonus_amount,
        maturityAmount,
        maturity_amount,
        nomineeName,
        nominee_name,
        nomineeRelation,
        nominee_relation,
        autoDebit,
        auto_debit,
        paymentMethod,
        payment_method,
        paymentId: customPaymentId,
        enrollmentNo: customEnrollmentNo,
        receiptNo: customReceiptNo,
    } = req.body;

    const finalUserId = userId || user_id || (req.user && req.user.id) || 1;
    const finalAmount = parseFloat(monthlyAmount || monthly_amount || 1000);
    const finalPaymentId = customPaymentId || `ENR_CJ_${Date.now().toString().slice(-8)}`;
    const finalEnrollmentNo = customEnrollmentNo || `ENR-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    const finalReceiptNo = customReceiptNo || `REC-CJ-${Math.floor(100000 + Math.random() * 900000)}`;
    const finalPan = (panNumber || pan_number || '').trim().toUpperCase();
    const finalMetal = metalType || metal_type || 'Gold';
    const finalDuration = parseInt(durationMonths || duration_months || 12, 10);
    const finalBonusAmt = parseFloat(bonusAmount || bonus_amount || 0);
    const finalMaturityAmt = parseFloat(maturityAmount || maturity_amount || 0);
    const finalNomineeName = (nomineeName || nominee_name || '').trim();
    const finalNomineeRel = (nomineeRelation || nominee_relation || 'Spouse').trim();
    const finalAutoDebit = (autoDebit !== undefined && autoDebit !== null) ? (autoDebit ? 1 : 0) : ((auto_debit !== undefined) ? (auto_debit ? 1 : 0) : 1);
    const finalPaymentMethod = (paymentMethod || payment_method || 'UPI').toUpperCase();

    // Helper to proceed with full database insertion
    const executeEnrollmentSave = (resolvedName, resolvedEmail, resolvedMobile, resolvedAddress, resolvedSchemeTitle) => {
        const insertEnrollmentQuery = `
            INSERT INTO enrollments (
                enrollment_no,
                receipt_no,
                user_id,
                customer_name,
                customer_mobile,
                customer_email,
                customer_address,
                pan_number,
                scheme_id,
                scheme_name,
                metal_type,
                monthly_amount,
                duration_months,
                bonus_amount,
                maturity_amount,
                nominee_name,
                nominee_relation,
                auto_debit,
                payment_method,
                payment_id,
                status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
        `;

        const enrollmentValues = [
            finalEnrollmentNo,
            finalReceiptNo,
            finalUserId,
            resolvedName,
            resolvedMobile,
            resolvedEmail,
            resolvedAddress,
            finalPan || null,
            schemeId || scheme_id || null,
            resolvedSchemeTitle,
            finalMetal,
            finalAmount,
            finalDuration,
            finalBonusAmt,
            finalMaturityAmt,
            finalNomineeName,
            finalNomineeRel,
            finalAutoDebit,
            finalPaymentMethod,
            finalPaymentId
        ];

        db.query(insertEnrollmentQuery, enrollmentValues, (enrollErr, enrollResult) => {
            if (enrollErr) {
                console.error("Error inserting into enrollments table:", enrollErr);
                return res.status(500).json({ success: false, message: "Failed to store enrollment data.", error: enrollErr.message });
            }

            const insertedEnrollmentId = enrollResult.insertId;

            // Also record in transactions table for user portfolio ledger
            const txDetails = JSON.stringify({
                enrollmentId: insertedEnrollmentId,
                enrollmentNo: finalEnrollmentNo,
                receiptNo: finalReceiptNo,
                nomineeName: finalNomineeName,
                nomineeRelation: finalNomineeRel,
                autoDebit: finalAutoDebit,
                paymentMethod: finalPaymentMethod,
                customerMobile: resolvedMobile,
                customerAddress: resolvedAddress,
                panNumber: finalPan || null
            });

            const insertTxQuery = `
                INSERT INTO transactions (
                    user_id,
                    type,
                    title,
                    details,
                    amount,
                    weight_grams,
                    payment_id,
                    status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SUCCESS')
            `;

            db.query(insertTxQuery, [
                finalUserId,
                'SCHEME_ENROLL',
                `Enrolled: ${resolvedSchemeTitle}`,
                txDetails,
                finalAmount,
                0.0000,
                finalPaymentId
            ], (txErr) => {
                if (txErr) {
                    console.warn("Warning: Could not record transaction ledger for enrollment:", txErr.message);
                }

                console.log(`[DB] Successfully stored scheme enrollment #${insertedEnrollmentId} for user ${resolvedName} (${resolvedMobile})`);

                res.status(201).json({
                    success: true,
                    message: "Scheme enrollment saved to database successfully.",
                    id: insertedEnrollmentId,
                    enrollmentId: insertedEnrollmentId,
                    enrollmentNo: finalEnrollmentNo,
                    receiptNo: finalReceiptNo,
                    customerName: resolvedName,
                    customerMobile: resolvedMobile,
                    customerEmail: resolvedEmail,
                    customerAddress: resolvedAddress,
                    schemeName: resolvedSchemeTitle,
                    monthlyAmount: finalAmount,
                    metalType: finalMetal,
                    durationMonths: finalDuration,
                    bonusAmount: finalBonusAmt,
                    maturityAmount: finalMaturityAmt,
                    nomineeName: finalNomineeName,
                    nomineeRelation: finalNomineeRel,
                    autoDebit: finalAutoDebit,
                    paymentMethod: finalPaymentMethod,
                    paymentId: finalPaymentId,
                    status: 'ACTIVE'
                });
            });
        });
    };

    // Resolve customer and scheme info
    const resolvedName = (fullName || customerName || customer_name || '').trim();
    const resolvedMobile = (mobileNumber || customerMobile || customer_mobile || '').trim();
    const resolvedEmail = (emailAddress || customerEmail || customer_email || '').trim();
    const resolvedAddress = (addressText || customerAddress || customer_address || '').trim();
    const targetSchemeId = schemeId || scheme_id;
    const targetSchemeName = (schemeName || scheme_name || '').trim();

    // If customer details were not supplied in request, fetch from users table
    if (!resolvedName || !resolvedMobile) {
        db.query('SELECT name, mobile, email, address FROM users WHERE id = ?', [finalUserId], (uErr, uRows) => {
            const dbUser = (!uErr && uRows && uRows[0]) ? uRows[0] : {};
            const finalName = resolvedName || dbUser.name || 'Valued Sovereign Investor';
            const finalMobile = resolvedMobile || dbUser.mobile || '9876543210';
            const finalEmail = resolvedEmail || dbUser.email || '';
            const finalAddr = resolvedAddress || dbUser.address || '';

            if (targetSchemeName) {
                executeEnrollmentSave(finalName, finalEmail, finalMobile, finalAddr, targetSchemeName);
            } else if (targetSchemeId) {
                db.query('SELECT name FROM schemes WHERE id = ?', [targetSchemeId], (sErr, sRows) => {
                    const sName = (!sErr && sRows && sRows[0]) ? sRows[0].name : 'Swarna Dhanvriddhi Scheme';
                    executeEnrollmentSave(finalName, finalEmail, finalMobile, finalAddr, sName);
                });
            } else {
                executeEnrollmentSave(finalName, finalEmail, finalMobile, finalAddr, 'Swarna Dhanvriddhi Scheme');
            }
        });
    } else {
        if (targetSchemeName) {
            executeEnrollmentSave(resolvedName, resolvedEmail, resolvedMobile, resolvedAddress, targetSchemeName);
        } else if (targetSchemeId) {
            db.query('SELECT name FROM schemes WHERE id = ?', [targetSchemeId], (sErr, sRows) => {
                const sName = (!sErr && sRows && sRows[0]) ? sRows[0].name : 'Swarna Dhanvriddhi Scheme';
                executeEnrollmentSave(resolvedName, resolvedEmail, resolvedMobile, resolvedAddress, sName);
            });
        } else {
            executeEnrollmentSave(resolvedName, resolvedEmail, resolvedMobile, resolvedAddress, 'Swarna Dhanvriddhi Scheme');
        }
    }
});

// Fetch all enrolled schemes from database
app.get(['/api/enrollments', '/api/schemes/enrollments'], (req, res) => {
    const query = `
        SELECT
            e.*,
            e.enrollment_no AS enrollmentNo,
            e.receipt_no AS receiptNo,
            e.customer_name AS customerName,
            e.customer_mobile AS customerMobile,
            e.customer_email AS customerEmail,
            e.customer_address AS customerAddress,
            e.pan_number AS panNumber,
            e.scheme_name AS schemeName,
            e.metal_type AS metalType,
            e.monthly_amount AS monthlyAmount,
            e.duration_months AS durationMonths,
            e.bonus_amount AS bonusAmount,
            e.maturity_amount AS maturityAmount,
            e.nominee_name AS nomineeName,
            e.nominee_relation AS nomineeRelation,
            e.auto_debit AS autoDebit,
            e.payment_method AS paymentMethod,
            e.payment_id AS paymentId,
            e.created_at AS createdAt
        FROM enrollments e
        ORDER BY e.created_at DESC
    `;
    db.query(query, (err, rows) => {
        if (err) {
            console.error("Error fetching enrollments:", err);
            return res.status(500).json({ success: false, message: "Database error." });
        }
        res.status(200).json({ success: true, data: rows });
    });
});

// Fetch enrollments for a specific user from database
app.get(['/api/enrollments/user/:userId', '/api/user/enrollments/:userId'], (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT
            e.*,
            e.enrollment_no AS enrollmentNo,
            e.receipt_no AS receiptNo,
            e.customer_name AS customerName,
            e.customer_mobile AS customerMobile,
            e.customer_email AS customerEmail,
            e.customer_address AS customerAddress,
            e.pan_number AS panNumber,
            e.scheme_name AS schemeName,
            e.metal_type AS metalType,
            e.monthly_amount AS monthlyAmount,
            e.duration_months AS durationMonths,
            e.bonus_amount AS bonusAmount,
            e.maturity_amount AS maturityAmount,
            e.nominee_name AS nomineeName,
            e.nominee_relation AS nomineeRelation,
            e.auto_debit AS autoDebit,
            e.payment_method AS paymentMethod,
            e.payment_id AS paymentId,
            e.created_at AS createdAt
        FROM enrollments e
        WHERE e.user_id = ?
        ORDER BY e.created_at DESC
    `;
    db.query(query, [userId], (err, rows) => {
        if (err) {
            console.error("Error fetching user enrollments:", err);
            return res.status(500).json({ success: false, message: "Database error." });
        }
        res.status(200).json({ success: true, data: rows });
    });
});

// Portfolio summary for user
app.get('/api/user/portfolio/:userId', (req, res) => {
    const userId = req.params.userId;
    const txQuery = 'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC';
    const enrQuery = 'SELECT COUNT(*) AS activeCount, COALESCE(SUM(monthly_amount), 0) AS totalMonthly FROM enrollments WHERE user_id = ? AND status = "ACTIVE"';

    db.query(txQuery, [userId], (txErr, transactions) => {
        if (txErr) {
            return res.status(500).json({ success: false, message: "Database error." });
        }

        let totalGold = 0.0;
        let totalSilver = 0.0;
        let totalInvested = 0.0;

        (transactions || []).forEach(tx => {
            const amt = parseFloat(tx.amount || 0);
            const w = parseFloat(tx.weight_grams || 0);
            const type = (tx.type || '').toUpperCase();

            if (type.includes('BUY_GOLD') || type.includes('GOLD_BUY')) {
                totalGold += w;
                totalInvested += amt;
            } else if (type.includes('SELL_GOLD') || type.includes('GOLD_SELL')) {
                totalGold -= w;
                totalInvested -= amt;
            } else if (type.includes('BUY_SILVER') || type.includes('SILVER_BUY')) {
                totalSilver += w;
                totalInvested += amt;
            } else if (type.includes('SELL_SILVER') || type.includes('SILVER_SELL')) {
                totalSilver -= w;
                totalInvested -= amt;
            } else {
                totalInvested += amt;
            }
        });

        db.query(enrQuery, [userId], (enrErr, enrRows) => {
            const activeSchemesCount = (!enrErr && enrRows && enrRows[0]) ? enrRows[0].activeCount : 0;

            res.status(200).json({
                success: true,
                summary: {
                    totalGoldGrams: Math.max(0, totalGold),
                    totalSilverGrams: Math.max(0, totalSilver),
                    totalInvestedAmount: Math.max(0, totalInvested),
                    activeSchemesCount: activeSchemesCount,
                    productsPurchasedCount: 0
                },
                transactions: transactions || []
            });
        });
    });
});

// Alias: Scheme Pay Installment Endpoint
app.post(['/api/enrollments/pay-installment', '/api/schemes/pay-installment'], (req, res) => {
    const { userId, user_id, folioId, enrollmentId, enrollmentNo, schemeName, installmentNumber, amount, paymentMethod, autoDebit } = req.body;
    const finalUserId = userId || user_id || (req.user && req.user.id) || 1;
    const finalAmount = parseFloat(amount || 1000);
    const finalTitle = `${schemeName || 'Swarna Dhanvriddhi Scheme'} (Installment #${installmentNumber || 2})`;
    const paymentId = `PAY_EMI_${Date.now().toString().slice(-8)}`;
    const finalFolio = folioId || enrollmentNo || (enrollmentId ? `ENR-${String(enrollmentId).padStart(5, '0')}` : 'CJ-SCHEME-FOLIO');

    const query = 'INSERT INTO transactions (user_id, type, title, details, amount, weight_grams, payment_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    db.query(query, [
        finalUserId,
        'SCHEME_INSTALLMENT',
        finalTitle,
        JSON.stringify({ folioId: finalFolio, enrollmentId, enrollmentNo: finalFolio, installmentNumber, paymentMethod: paymentMethod || 'STORE_OFFLINE', autoDebit: autoDebit ? 1 : 0 }),
        finalAmount,
        0.0000,
        paymentId,
        'SUCCESS'
    ], (err, result) => {
        if (err) {
            console.error("Error recording installment:", err);
            return res.status(500).json({ success: false, message: "Database error." });
        }
        res.status(201).json({
            success: true,
            id: result.insertId,
            receiptNo: paymentId,
            amount: finalAmount,
            installmentNumber,
            status: 'SUCCESS'
        });
    });
});

// Alias: Bullion Sells Endpoint
app.post(['/api/sells/create', '/api/sells'], (req, res) => {
    const { userId, user_id, metal, grams, amount } = req.body;
    const finalUserId = userId || user_id || (req.user && req.user.id) || 1;
    const isSilver = String(metal || '').toLowerCase().includes('silver');
    const finalType = isSilver ? 'SELL_SILVER' : 'SELL_GOLD';
    const finalTitle = `Sell ${isSilver ? 'Silver' : 'Gold'} Bullion (${grams}g)`;
    const finalAmount = parseFloat(amount || 0);
    const finalWeight = parseFloat(grams || 0);
    const paymentId = `SELL_CJ_${Date.now().toString().slice(-8)}`;

    const query = 'INSERT INTO transactions (user_id, type, title, details, amount, weight_grams, payment_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    db.query(query, [finalUserId, finalType, finalTitle, '', finalAmount, finalWeight, paymentId, 'PENDING'], (err, result) => {
        if (err) {
            console.error("Error creating sell transaction:", err);
            return res.status(500).json({ success: false, message: "Database error." });
        }
        res.status(201).json({
            success: true,
            id: result.insertId,
            type: finalType,
            amount: finalAmount,
            weightGrams: finalWeight,
            status: 'PENDING'
        });
    });
});

app.get(['/api/transactions', '/api/transactions/user/:userId', '/api/user/transactions/:userId'], (req, res) => {
    const userId = req.params.userId || req.query.userId || req.query.user_id;
    let query = `
        SELECT
            t.id,
            t.user_id AS userId,
            t.user_id,
            u.name AS customer,
            t.type,
            COALESCE(t.title, '-') AS metal,
            COALESCE(t.title, '-') AS title,
            t.details,
            COALESCE(t.weight_grams, 0) AS grams,
            COALESCE(t.weight_grams, 0) AS weightGrams,
            COALESCE(t.weight_grams, 0) AS weight_grams,
            t.amount,
            t.payment_id AS paymentId,
            t.payment_id,
            t.status,
            t.created_at AS time,
            t.created_at AS createdAt,
            t.created_at
        FROM transactions t
        LEFT JOIN users u ON t.user_id = u.id
    `;
    const params = [];
    if (userId) {
        query += " WHERE t.user_id = ?";
        params.push(userId);
    }
    query += " ORDER BY t.created_at DESC";

    db.query(query, params, (err, results) => {
        if (err) {
            console.error("Database error fetching transactions:", err);
            return res.status(500).json({ message: 'Database error.', error: err });
        }
        res.json(results);
    });
});

app.get('/api/transactions/enrollments', (req, res) => {
    const query = `
        SELECT
            t.id,
            COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(t.details, '$.enrollmentNo')), 'null'), CONCAT('ENR-', LPAD(t.id, 5, '0'))) AS enrollment_no,
            u.id AS user_id,
            u.name AS customer_name,
            u.email AS customer_email,
            COALESCE(NULLIF(u.mobile, ''), JSON_UNQUOTE(JSON_EXTRACT(t.details, '$.customerMobile')), '') AS customer_mobile,
            t.title AS scheme_name,
            t.amount AS monthly_amount,
            t.created_at AS start_date,
            t.details AS details,

            COALESCE(s.tenure_months, s.duration_months, 11) AS tenure_months,
            COALESCE(s.bonus_months, 1) AS bonus_months,

            -- Calculate Maturity Date: Add tenure_months to the start_date
            DATE_ADD(t.created_at, INTERVAL COALESCE(s.tenure_months, s.duration_months, 11) MONTH) AS maturity_date,

            -- Calculate Maturity Amount: monthly_amount * (tenure_months + bonus_months)
            (t.amount * (COALESCE(s.tenure_months, s.duration_months, 11) + COALESCE(s.bonus_months, 1))) AS maturity_amount,

            (
                SELECT COUNT(*)
                FROM transactions ti
                WHERE ti.type = 'SCHEME_INSTALLMENT'
                  AND ti.status = 'SUCCESS'
                  AND ti.user_id = t.user_id
                  AND (
                      ti.details LIKE CONCAT('%', CONCAT('ENR-', LPAD(t.id, 5, '0')), '%')
                      OR (t.details IS NOT NULL AND ti.details LIKE CONCAT('%', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.details, '$.enrollmentNo')), '---'), '%'))
                      OR ti.details LIKE CONCAT('%"enrollmentId":', t.id, '%')
                      OR ti.title LIKE CONCAT('%', REPLACE(REPLACE(t.title, 'Enrolled: ', ''), 'Scheme: ', ''), '%')
                  )
            ) AS additional_installments_paid,

            t.status
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN schemes s ON t.title LIKE CONCAT('%', s.name, '%')
        WHERE t.type = 'SCHEME_ENROLL'
        ORDER BY t.created_at DESC
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error("Database error fetching enrollments:", err);
            return res.status(500).json({ message: 'Database error.', error: err });
        }

        const now = new Date();
        const processed = results.map(row => {
            const tenureMonths = Number(row.tenure_months) || 11;
            const additionalPaid = Number(row.additional_installments_paid) || 0;
            const installmentsPaid = 1 + additionalPaid; // 1st installment paid upon enrollment
            const isMatured = installmentsPaid >= tenureMonths;

            let nextEmiDate = null;
            let daysUntilDue = null;
            let isAlert = false;
            let dueStatus = 'NORMAL';

            if (!isMatured) {
                const startDate = new Date(row.start_date);
                nextEmiDate = new Date(startDate);
                nextEmiDate.setMonth(startDate.getMonth() + installmentsPaid);

                const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const d2 = new Date(nextEmiDate.getFullYear(), nextEmiDate.getMonth(), nextEmiDate.getDate());
                daysUntilDue = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));

                if (daysUntilDue < 0) {
                    isAlert = true;
                    dueStatus = 'OVERDUE';
                } else if (daysUntilDue <= 5) {
                    isAlert = true;
                    dueStatus = 'DUE_SOON';
                } else {
                    isAlert = false;
                    dueStatus = 'NORMAL';
                }
            } else {
                dueStatus = 'COMPLETED';
            }

            return {
                ...row,
                customer_mobile: row.customer_mobile || '',
                installments_paid: installmentsPaid,
                next_installment_number: isMatured ? null : (installmentsPaid + 1),
                tenure_months: tenureMonths,
                next_emi_date: nextEmiDate ? nextEmiDate.toISOString() : null,
                days_until_due: daysUntilDue,
                is_alert: isAlert,
                due_status: dueStatus
            };
        });

        res.json(processed);
    });
});

app.get('/api/payments', (req, res) => {
    const query = `
        SELECT
            t.id,
            t.payment_id AS transaction_reference,
            COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(t.details, '$.enrollmentNo')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(t.details, '$.folioId')), 'null'), CONCAT('ENR-', LPAD(t.id, 5, '0'))) AS enrollment_no,
            u.name AS customer_name,
            t.amount,
            COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(t.details, '$.paymentMethod')), 'null'), 'ONLINE / UPI') AS payment_method,
            t.created_at,
            t.status
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        WHERE t.type IN ('SCHEME_ENROLL', 'SCHEME_INSTALLMENT')
        ORDER BY t.created_at DESC
    `;
    db.query(query, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        res.json(rows);
    });
});

// Get all Sell requests and Payouts (for Admin Dashboard)
app.get('/api/transactions/sells', (req, res) => {
    const query = `
        SELECT
            t.id,
            u.id AS user_id,
            u.name AS customer_name,
            u.email AS customer_email,
            u.mobile AS customer_mobile,
            t.type,
            t.title,
            t.details,
            t.amount,
            t.weight_grams AS weightGrams,
            t.payment_id AS paymentId,
            t.status,
            t.created_at AS createdAt
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        WHERE t.type LIKE '%SELL%'
        ORDER BY t.created_at DESC
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error("Database error fetching sell requests:", err);
            return res.status(500).json({ message: "Database error." });
        }
        res.json(results);
    });
});

// Additional Admin Sell Requests & Filtering Endpoints
app.get(['/api/admin/sells', '/api/admin/sell-requests', '/api/transactions/sells/pending'], (req, res) => {
    const statusFilter = req.query.status;
    let query = `
        SELECT
            t.id,
            u.id AS user_id,
            u.name AS customer_name,
            u.email AS customer_email,
            u.mobile AS customer_mobile,
            t.type,
            t.title,
            t.details,
            t.amount,
            t.weight_grams AS weightGrams,
            t.payment_id AS paymentId,
            t.status,
            t.created_at AS createdAt
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        WHERE t.type LIKE '%SELL%'
    `;
    const params = [];
    if (statusFilter) {
        query += " AND t.status = ?";
        params.push(statusFilter);
    }
    query += " ORDER BY t.created_at DESC";

    db.query(query, params, (err, results) => {
        if (err) {
            console.error("Database error fetching admin sell requests:", err);
            return res.status(500).json({ message: "Database error." });
        }
        res.json(results);
    });
});

// Admin Mark Payout Completed (within 24 hrs window)
app.put('/api/transactions/:id/payout', (req, res) => {
    const txId = req.params.id;
    const { status } = req.body;
    const finalStatus = status || 'SUCCESS';

    db.query("UPDATE transactions SET status = ? WHERE id = ?", [finalStatus, txId], (err, result) => {
        if (err) {
            console.error("Database error updating payout status:", err);
            return res.status(500).json({ message: "Database error." });
        }
        res.json({ message: "Payout status updated successfully", status: finalStatus });
    });
});

app.get('/api/user/portfolio/:userId', (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT
            t.id,
            t.user_id,
            t.user_id AS userId,
            t.type,
            t.title,
            t.details,
            t.amount,
            t.weight_grams,
            t.weight_grams AS weightGrams,
            t.payment_id,
            t.payment_id AS paymentId,
            t.status,
            t.created_at,
            t.created_at AS createdAt,
            CONCAT('ENR-', LPAD(t.id, 5, '0')) AS enrollmentNo,
            DATE_ADD(t.created_at, INTERVAL COALESCE(s.tenure_months, s.duration_months, 11) MONTH) AS maturityDate,
            (t.amount * (COALESCE(s.tenure_months, s.duration_months, 11) + COALESCE(s.bonus_months, 1))) AS maturityAmount
        FROM transactions t
        LEFT JOIN schemes s ON t.title LIKE CONCAT('%', s.name, '%')
        WHERE t.user_id = ?
        ORDER BY t.id DESC
    `;

    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }

        let totalGold = 0.0;
        let totalSilver = 0.0;
        let totalInvested = 0.0;
        let activeSchemesCount = 0;
        let productsPurchasedCount = 0;

        results.forEach(tx => {
            const statusUpper = (tx.status || 'COMPLETED').toUpperCase();
            if (statusUpper === 'FAILED' || statusUpper === 'CANCELLED' || statusUpper === 'REJECTED') return;
            const amt = parseFloat(tx.amount || 0);
            const w = parseFloat(tx.weightGrams || 0);
            const typeUpper = (tx.type || '').toUpperCase();

            if (typeUpper.includes('BUY_GOLD') || typeUpper === 'GOLD_BUY' || typeUpper === 'BUY GOLD') {
                totalGold += w;
                totalInvested += amt;
            } else if (typeUpper.includes('SELL_GOLD') || typeUpper === 'GOLD_SELL' || typeUpper === 'SELL GOLD') {
                totalGold -= w;
                totalInvested -= amt;
            } else if (typeUpper.includes('BUY_SILVER') || typeUpper === 'SILVER_BUY' || typeUpper === 'BUY SILVER') {
                totalSilver += w;
                totalInvested += amt;
            } else if (typeUpper.includes('SELL_SILVER') || typeUpper === 'SILVER_SELL' || typeUpper === 'SILVER SELL') {
                totalSilver -= w;
                totalInvested -= amt;
            } else if (typeUpper.includes('SCHEME')) {
                totalInvested += amt;
                activeSchemesCount++;
            } else if (typeUpper.includes('PRODUCT')) {
                totalInvested += amt;
                productsPurchasedCount++;
            } else {
                totalInvested += amt;
            }
        });

        res.status(200).json({
            summary: {
                totalGoldGrams: Math.max(0, totalGold),
                totalSilverGrams: Math.max(0, totalSilver),
                totalInvestedAmount: Math.max(0, totalInvested),
                activeSchemesCount: activeSchemesCount,
                productsPurchasedCount: productsPurchasedCount
            },
            transactions: results
        });
    });
});

// --- E. METAL RATES ENDPOINTS ---
app.get('/api/metal-rates', (req, res) => {
    // Get latest base rates set by admin in dashboard
    const query = 'SELECT * FROM metal_rates ORDER BY id DESC LIMIT 1';
    db.query(query, (err, results) => {
        if (err) {
            console.error("Database error fetching metal rates:", err);
            return res.status(500).json({ message: 'Database error.', error: err });
        }

        let baseGold = 7500.00;
        let baseSilver = 90.00;

        if (results && results.length > 0) {
            const row = results[0];
            if (row.gold_rate && parseFloat(row.gold_rate) > 0) baseGold = parseFloat(row.gold_rate);
            if (row.silver_rate && parseFloat(row.silver_rate) > 0) baseSilver = parseFloat(row.silver_rate);
        }

        const k24 = Math.round(baseGold * 100) / 100;
        const k22 = Math.round(baseGold * (22 / 24) * 100) / 100;
        const k18 = Math.round(baseGold * (18 / 24) * 100) / 100;
        const s999 = Math.round(baseSilver * 100) / 100;
        const s925 = Math.round(baseSilver * (925 / 999) * 100) / 100;

        // Dynamically compute derived variety rates based on purity percentage
        const varieties = [
            {
                id: 1,
                metalType: 'GOLD',
                purity: '24K',
                title: '24K Pure Gold (99.9%)',
                buyPricePerGram: k24,
                sellPricePerGram: Math.round(k24 * 0.98 * 100) / 100,
                isActive: true
            },
            {
                id: 2,
                metalType: 'GOLD',
                purity: '22K',
                title: '22K Standard Gold (91.6%)',
                buyPricePerGram: k22,
                sellPricePerGram: Math.round(k22 * 0.98 * 100) / 100,
                isActive: true
            },
            {
                id: 3,
                metalType: 'GOLD',
                purity: '18K',
                title: '18K Jewellery Gold (75.0%)',
                buyPricePerGram: k18,
                sellPricePerGram: Math.round(k18 * 0.98 * 100) / 100,
                isActive: true
            },
            {
                id: 4,
                metalType: 'SILVER',
                purity: '99.9%',
                title: '99.9% Fine Silver',
                buyPricePerGram: s999,
                sellPricePerGram: Math.round(s999 * 0.98 * 100) / 100,
                isActive: true
            },
            {
                id: 5,
                metalType: 'SILVER',
                purity: '92.5%',
                title: '92.5% Sterling Silver',
                buyPricePerGram: s925,
                sellPricePerGram: Math.round(s925 * 0.98 * 100) / 100,
                isActive: true
            }
        ];

        res.json(varieties);
    });
});

app.post('/api/metal-rates', (req, res) => {
    const { gold_rate, silver_rate, goldRate, silverRate, gold_change, silver_change, admin_markup, updated_by } = req.body;
    const finalGold = gold_rate || goldRate || 7500.00;
    const finalSilver = silver_rate || silverRate || 90.00;
    const finalGoldChange = gold_change || 0.00;
    const finalSilverChange = silver_change || 0.00;
    const finalMarkup = admin_markup || 0.00;
    const finalUpdatedBy = updated_by || 'ADMIN';

    const query = 'INSERT INTO metal_rates (gold_rate, silver_rate, gold_change, silver_change, admin_markup, updated_by) VALUES (?, ?, ?, ?, ?, ?)';
    db.query(query, [finalGold, finalSilver, finalGoldChange, finalSilverChange, finalMarkup, finalUpdatedBy], (err, result) => {
        if (err) {
            console.error("Error inserting metal rate:", err);
            return res.status(500).json({ message: 'Database error.', error: err });
        }
        res.status(201).json({ message: 'Metal rates updated successfully', id: result.insertId, gold_rate: finalGold, silver_rate: finalSilver });
    });
});

// Helper function to calculate all standard Gold Karats & Silver Fineness
const calculatePurities = (gold24K, silver999) => {
    const g = parseFloat(gold24K) || 0;
    const s = parseFloat(silver999) || 0;
    return {
        goldPurities: {
            k24: Math.round(g * 100) / 100,
            k22: Math.round(g * (22 / 24) * 100) / 100,
            k18: Math.round(g * (18 / 24) * 100) / 100,
            k14: Math.round(g * (14 / 24) * 100) / 100
        },
        silverPurities: {
            s999: Math.round(s * 100) / 100,
            s925: Math.round(s * (925 / 999) * 100) / 100,
            s800: Math.round(s * (800 / 999) * 100) / 100
        }
    };
};

// Get Dashboard Live Rates with Purity Breakdown
app.get('/api/rates', (req, res) => {
    const query = 'SELECT * FROM metal_rates ORDER BY id DESC LIMIT 1';
    db.query(query, (err, results) => {
        if (err) {
            console.error("Database error fetching rates:", err);
            return res.status(500).json({ message: "Database error.", error: err });
        }
        if (results.length === 0) {
            const purities = calculatePurities(7500.00, 90.00);
            return res.json({
                id: 1,
                gold: 7500.00,
                silver: 90.00,
                ...purities,
                goldChange: 0.82,
                silverChange: -0.34,
                markup: 0.00,
                updatedAt: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ' IST',
                createdAt: new Date().toISOString()
            });
        }
        const row = results[0];
        const dateObj = new Date(row.created_at);
        const timeStr = dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ' IST';
        const goldVal = parseFloat(row.gold_rate);
        const silverVal = parseFloat(row.silver_rate);
        const purities = calculatePurities(goldVal, silverVal);

        res.json({
            id: row.id,
            gold: goldVal,
            silver: silverVal,
            ...purities,
            goldChange: parseFloat(row.gold_change || 0.00),
            silverChange: parseFloat(row.silver_change || 0.00),
            markup: parseFloat(row.admin_markup || 0.00),
            updatedBy: row.updated_by || 'ADMIN',
            updatedAt: timeStr,
            createdAt: row.created_at
        });
    });
});

// Set Dashboard Live Rates (Admin)
app.post('/api/rates', (req, res) => {
    const { gold, goldRate, gold_rate, silver, silverRate, silver_rate, goldChange, gold_change, silverChange, silver_change, markup, adminMarkup, admin_markup, updatedBy, updated_by } = req.body;

    db.query('SELECT * FROM metal_rates ORDER BY id DESC LIMIT 1', (err, results) => {
        let prevGold = 7500.00;
        let prevSilver = 90.00;
        let prevGoldChange = 0.82;
        let prevSilverChange = -0.34;
        let prevMarkup = 0.00;

        if (!err && results && results.length > 0) {
            prevGold = parseFloat(results[0].gold_rate);
            prevSilver = parseFloat(results[0].silver_rate);
            prevGoldChange = parseFloat(results[0].gold_change || 0);
            prevSilverChange = parseFloat(results[0].silver_change || 0);
            prevMarkup = parseFloat(results[0].admin_markup || 0.00);
        }

        const finalGold = (gold !== undefined && gold !== '') ? parseFloat(gold) : (goldRate !== undefined ? parseFloat(goldRate) : (gold_rate !== undefined ? parseFloat(gold_rate) : prevGold));
        const finalSilver = (silver !== undefined && silver !== '') ? parseFloat(silver) : (silverRate !== undefined ? parseFloat(silverRate) : (silver_rate !== undefined ? parseFloat(silver_rate) : prevSilver));
        const finalGoldChange = (goldChange !== undefined && goldChange !== '') ? parseFloat(goldChange) : (gold_change !== undefined ? parseFloat(gold_change) : prevGoldChange);
        const finalSilverChange = (silverChange !== undefined && silverChange !== '') ? parseFloat(silverChange) : (silver_change !== undefined ? parseFloat(silver_change) : prevSilverChange);
        const finalMarkup = (markup !== undefined && markup !== '') ? parseFloat(markup) : (adminMarkup !== undefined ? parseFloat(adminMarkup) : (admin_markup !== undefined ? parseFloat(admin_markup) : prevMarkup));
        const finalUpdatedBy = updatedBy || updated_by || 'ADMIN';

        const insertQuery = `
            INSERT INTO metal_rates (gold_rate, silver_rate, gold_change, silver_change, admin_markup, updated_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        db.query(insertQuery, [finalGold, finalSilver, finalGoldChange, finalSilverChange, finalMarkup, finalUpdatedBy], (insertErr, insertResult) => {
            if (insertErr) {
                console.error("Database error saving metal rate:", insertErr);
                return res.status(500).json({ message: "Database error.", error: insertErr });
            }

            const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ' IST';
            const purities = calculatePurities(finalGold, finalSilver);

            res.status(201).json({
                message: "Metal rates updated successfully",
                id: insertResult.insertId,
                gold: finalGold,
                silver: finalSilver,
                ...purities,
                goldChange: finalGoldChange,
                silverChange: finalSilverChange,
                markup: finalMarkup,
                updatedBy: finalUpdatedBy,
                updatedAt: timeStr,
                createdAt: new Date().toISOString()
            });
        });
    });
});

// Rate History
app.get('/api/rates/history', (req, res) => {
    const query = 'SELECT * FROM metal_rates ORDER BY id DESC LIMIT 20';
    db.query(query, (err, results) => {
        if (err) {
            return res.status(500).json({ message: "Database error.", error: err });
        }
        res.json(results.map(r => {
            const goldVal = parseFloat(r.gold_rate);
            const silverVal = parseFloat(r.silver_rate);
            const purities = calculatePurities(goldVal, silverVal);
            return {
                id: r.id,
                gold: goldVal,
                silver: silverVal,
                ...purities,
                goldChange: parseFloat(r.gold_change || 0.00),
                silverChange: parseFloat(r.silver_change || 0.00),
                markup: parseFloat(r.admin_markup || 0.00),
                updatedBy: r.updated_by,
                createdAt: r.created_at
            };
        }));
    });
});

// --- F. CATEGORIES API ENDPOINTS ---
app.get('/api/categories', (req, res) => {
    db.query('SELECT * FROM categories ORDER BY name ASC', (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(200).json(results);
    });
});

app.post('/api/categories', (req, res) => {
    const { name, description } = req.body;
    if (!name) {
        return res.status(400).json({ message: "Category name is required." });
    }
    const query = 'INSERT INTO categories (name, description) VALUES (?, ?) ON DUPLICATE KEY UPDATE description = VALUES(description)';
    db.query(query, [name, description || ''], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(201).json({ id: result.insertId || result.id, name, description });
    });
});

app.delete('/api/categories/:id', (req, res) => {
    db.query('DELETE FROM categories WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ message: "Database error." });
        res.status(200).json({ message: "Category deleted successfully" });
    });
});

// --- G. PRODUCTS API ENDPOINTS ---
app.get('/api/products', (req, res) => {
    const query = `
        SELECT
            p.id,
            p.name,
            p.category_id,
            c.name AS category_name,
            p.image_url,
            p.price,
            p.stock_quantity,
            p.description
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        ORDER BY p.id DESC
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        const mapped = results.map(row => ({
            id: row.id,
            name: row.name,
            categoryId: row.category_id,
            category_id: row.category_id,
            categoryName: row.category_name || 'General',
            category_name: row.category_name || 'General',
            category: row.category_name || 'General',
            imageUrl: row.image_url || '',
            image_url: row.image_url || '',
            price: parseFloat(row.price || 0.00),
            stockQuantity: row.stock_quantity || 0,
            stock_quantity: row.stock_quantity || 0,
            description: row.description || '',
            purity: '24K',
            grossWeight: 0.00,
            gross_weight: 0.00,
            makingChargesPercent: 0.00,
            making_charges_percent: 0.00
        }));
        res.status(200).json(mapped);
    });
});

app.post('/api/products', upload.single('image'), (req, res) => {
    const {
        name,
        category, categoryId, category_id,
        imageUrl, image_url,
        price,
        stockQuantity, stock_quantity,
        description
    } = req.body;

    const finalName = name || 'New Product';
    const finalImageUrl = req.file ? `/uploads/${req.file.filename}` : (imageUrl || image_url || '');
    const finalPrice = price || 0.00;
    const finalStock = stockQuantity || stock_quantity || 0;
    const finalDesc = description || '';

    const insertProduct = (catId) => {
        const query = 'INSERT INTO products (name, category_id, image_url, price, stock_quantity, description) VALUES (?, ?, ?, ?, ?, ?)';
        db.query(query, [finalName, catId, finalImageUrl, finalPrice, finalStock, finalDesc], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Database error." });
            }
            res.status(201).json({
                id: result.insertId,
                name: finalName,
                categoryId: catId,
                imageUrl: finalImageUrl,
                price: finalPrice,
                stockQuantity: finalStock,
                description: finalDesc
            });
        });
    };

    let targetCatId = categoryId || category_id;
    if (targetCatId) {
        insertProduct(targetCatId);
    } else if (category && typeof category === 'string') {
        db.query('SELECT id FROM categories WHERE name = ?', [category], (err, results) => {
            if (!err && results.length > 0) {
                insertProduct(results[0].id);
            } else {
                db.query('INSERT INTO categories (name) VALUES (?)', [category], (err, result) => {
                    if (!err && result.insertId) {
                        insertProduct(result.insertId);
                    } else {
                        insertProduct(null);
                    }
                });
            }
        });
    } else {
        insertProduct(null);
    }
});

// UPDATE Product Route
app.put('/api/products/:id', (req, res) => {
    const productId = req.params.id;
    const { name, category_id, image_url, price, stock_quantity, description } = req.body;

    const query = `
        UPDATE products
        SET name = ?, category_id = ?, image_url = ?, price = ?, stock_quantity = ?, description = ?
        WHERE id = ?
    `;

    db.query(query, [name, category_id, image_url, price, stock_quantity, description, productId], (err, results) => {
        if (err) {
            console.error("Database update error:", err);
            return res.status(500).json({ message: 'Database error.', error: err });
        }
        res.json({ message: 'Product updated successfully' });
    });
});

app.delete('/api/products/:id', (req, res) => {
    db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ message: "Database error." });
        res.status(200).json({ message: "Product deleted successfully" });
    });
});

// G. Fetch Schemes with Real-time Scheme Statistics for Admin Dashboard
app.get(['/api/schemes', '/api/admin/schemes'], (req, res) => {
    const query = `
        SELECT
            s.*,
            COUNT(DISTINCT t.user_id) AS enrolled_users,
            COUNT(t.id) AS active_subscriptions,
            COALESCE(SUM(t.amount), 0) AS monthly_capital,
            COALESCE(SUM(t.amount * (COALESCE(s.tenure_months, s.duration_months, 11) + COALESCE(s.bonus_months, 1))), 0) AS forecast_maturity
        FROM schemes s
        LEFT JOIN transactions t ON t.type = 'SCHEME_ENROLL' AND t.title LIKE CONCAT('%', s.name, '%')
        GROUP BY s.id
        ORDER BY s.id DESC
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error("Database error fetching schemes with stats:", err);
            return res.status(500).json({ message: "Database error." });
        }
        const mapped = results.map(row => {
            const enrolled = row.enrolled_users || 0;
            const subs = row.active_subscriptions || 0;
            const capital = parseFloat(row.monthly_capital || 0);
            const maturity = parseFloat(row.forecast_maturity || 0);

            return {
                id: row.id,
                name: row.name,
                metalType: row.metal_type || 'Gold',
                metal_type: row.metal_type || 'Gold',
                durationMonths: row.duration_months || row.tenure_months || 11,
                duration_months: row.duration_months || row.tenure_months || 11,
                tenureMonths: row.duration_months || row.tenure_months || 11,
                tenure_months: row.duration_months || row.tenure_months || 11,
                bonusMonths: row.bonus_months || 1,
                bonus_months: row.bonus_months || 1,
                minMonthlyInstallment: row.min_monthly_installment || 1000,
                min_monthly_installment: row.min_monthly_installment || 1000,
                maxMonthlyInstallment: row.max_monthly_installment || 50000,
                max_monthly_installment: row.max_monthly_installment || 50000,
                bonusText: row.bonus_text || '',
                bonus_text: row.bonus_text || '',
                termsAndConditions: row.terms_and_conditions || row.description || '',
                terms_and_conditions: row.terms_and_conditions || row.description || '',
                description: row.description || row.terms_and_conditions || '',
                isActive: row.is_active === 1,
                is_active: row.is_active === 1,
                // Scheme-specific stats for admin dashboard
                enrolledUsers: enrolled,
                enrolled_users: enrolled,
                activeSubscriptions: subs,
                active_subscriptions: subs,
                monthlyCapital: capital,
                monthly_capital: capital,
                forecastMaturity: maturity,
                forecast_maturity: maturity
            };
        });
        res.status(200).json(mapped);
    });
});

// UPDATE Scheme Routes (Supporting PUT, PATCH, POST and multiple URL patterns from dashboards)
const handleSchemeUpdate = (req, res) => {
    const schemeId = req.params.id;
    const body = req.body || {};

    db.query('SELECT * FROM schemes WHERE id = ?', [schemeId], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.status(404).json({ message: 'Scheme not found.' });
        }

        const current = results[0];

        const name = body.name !== undefined ? body.name : current.name;
        const metalType = body.metalType !== undefined ? body.metalType : (body.metal_type !== undefined ? body.metal_type : current.metal_type);
        const durationMonths = body.durationMonths !== undefined ? body.durationMonths : (body.duration_months !== undefined ? body.duration_months : (body.tenureMonths !== undefined ? body.tenureMonths : (body.tenure_months !== undefined ? body.tenure_months : current.duration_months)));
        const bonusMonths = body.bonusMonths !== undefined ? body.bonusMonths : (body.bonus_months !== undefined ? body.bonus_months : current.bonus_months);
        const minMonthlyInstallment = body.minMonthlyInstallment !== undefined ? body.minMonthlyInstallment : (body.min_monthly_installment !== undefined ? body.min_monthly_installment : current.min_monthly_installment);
        const maxMonthlyInstallment = body.maxMonthlyInstallment !== undefined ? body.maxMonthlyInstallment : (body.max_monthly_installment !== undefined ? body.max_monthly_installment : current.max_monthly_installment);
        const bonusText = body.bonusText !== undefined ? body.bonusText : (body.bonus_text !== undefined ? body.bonus_text : current.bonus_text);
        const termsAndConditions = body.termsAndConditions !== undefined ? body.termsAndConditions : (body.terms_and_conditions !== undefined ? body.terms_and_conditions : (body.description !== undefined ? body.description : current.terms_and_conditions));
        const description = body.description !== undefined ? body.description : (body.termsAndConditions !== undefined ? body.termsAndConditions : (body.terms_and_conditions !== undefined ? body.terms_and_conditions : current.description));
        const isActive = body.isActive !== undefined ? (body.isActive ? 1 : 0) : (body.is_active !== undefined ? (body.is_active ? 1 : 0) : current.is_active);

        const updateQuery = `
            UPDATE schemes
            SET name = ?,
                metal_type = ?,
                duration_months = ?,
                tenure_months = ?,
                bonus_months = ?,
                min_monthly_installment = ?,
                max_monthly_installment = ?,
                bonus_text = ?,
                terms_and_conditions = ?,
                description = ?,
                is_active = ?
            WHERE id = ?
        `;

        db.query(updateQuery, [
            name,
            metalType,
            durationMonths,
            durationMonths,
            bonusMonths,
            minMonthlyInstallment,
            maxMonthlyInstallment,
            bonusText,
            termsAndConditions,
            description,
            isActive,
            schemeId
        ], (updateErr) => {
            if (updateErr) {
                console.error("Database error updating scheme:", updateErr);
                return res.status(500).json({ message: 'Database error.', error: updateErr });
            }
            res.json({ message: 'Scheme updated successfully', id: schemeId });
        });
    });
};

app.put('/api/schemes/:id', handleSchemeUpdate);
app.patch('/api/schemes/:id', handleSchemeUpdate);
app.post('/api/schemes/:id', handleSchemeUpdate);
app.put('/api/schemes/:id/update', handleSchemeUpdate);
app.post('/api/schemes/:id/update', handleSchemeUpdate);

// Dashboard Statistics Endpoint
app.get(['/api/dashboard/stats', '/api/dashboard', '/api/admin/dashboard', '/api/stats'], (req, res) => {
    const qTotalRev = "SELECT COALESCE(SUM(amount), 0) AS totalRevenue FROM transactions WHERE status = 'SUCCESS'";
    const qGoldGrams = "SELECT COALESCE(SUM(weight_grams), 0) AS goldGrams FROM transactions WHERE type = 'BUY_GOLD' AND status = 'SUCCESS'";
    const qSilverGrams = "SELECT COALESCE(SUM(weight_grams), 0) AS silverGrams FROM transactions WHERE type = 'BUY_SILVER' AND status = 'SUCCESS'";
    const qSchemeCol = "SELECT COALESCE(SUM(amount), 0) AS schemeCollections FROM transactions WHERE type IN ('SCHEME_ENROLL', 'SCHEME_INSTALLMENT') AND status = 'SUCCESS'";
    const qPendingKyc = "SELECT COUNT(*) AS pendingKyc FROM users WHERE status = 'PENDING' OR status IS NULL OR status = ''";
    const qUsers = "SELECT COUNT(DISTINCT user_id) AS enrolledUsers, (SELECT COUNT(*) FROM users) AS totalUsers FROM transactions WHERE type = 'SCHEME_ENROLL'";
    const qSubs = "SELECT COUNT(*) AS activeSubscriptions, (SELECT COUNT(*) FROM schemes WHERE is_active = 1) AS activeSchemes FROM transactions WHERE type = 'SCHEME_ENROLL'";
    const qCapital = "SELECT COALESCE(SUM(amount), 0) AS monthlyCapital FROM transactions WHERE type = 'SCHEME_ENROLL'";
    const qMaturity = `
        SELECT COALESCE(SUM(t.amount * (COALESCE(s.tenure_months, s.duration_months, 11) + COALESCE(s.bonus_months, 1))), 0) AS forecastMaturity
        FROM transactions t
        LEFT JOIN schemes s ON t.title LIKE CONCAT('%', s.name, '%')
        WHERE t.type = 'SCHEME_ENROLL'
    `;
    const qSchemeMix = `
        SELECT 
            TRIM(REPLACE(REPLACE(title, 'Enrolled: ', ''), 'Scheme: ', '')) AS name,
            COUNT(*) AS value,
            COALESCE(SUM(amount), 0) AS total_amount
        FROM transactions
        WHERE type = 'SCHEME_ENROLL'
        GROUP BY name
    `;
    const qSalesDays = `
        SELECT 
            DATE(created_at) AS date_val,
            SUBSTRING(DAYNAME(created_at), 1, 3) AS label,
            COALESCE(SUM(CASE WHEN type = 'BUY_GOLD' THEN amount ELSE 0 END), 0) AS gold,
            COALESCE(SUM(CASE WHEN type = 'BUY_SILVER' THEN amount ELSE 0 END), 0) AS silver,
            COALESCE(SUM(CASE WHEN type IN ('SCHEME_ENROLL', 'SCHEME_INSTALLMENT') THEN amount ELSE 0 END), 0) AS schemes,
            COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE status = 'SUCCESS'
        GROUP BY date_val, label
        ORDER BY date_val ASC
    `;

    db.query(qTotalRev, (errRev, rRev) => {
        db.query(qGoldGrams, (errGold, rGold) => {
            db.query(qSilverGrams, (errSilver, rSilver) => {
                db.query(qSchemeCol, (errScheme, rScheme) => {
                    db.query(qPendingKyc, (errKyc, rKyc) => {
                        db.query(qUsers, (errUsers, rUsers) => {
                            db.query(qSubs, (errSubs, rSubs) => {
                                db.query(qCapital, (errCap, rCap) => {
                                    db.query(qMaturity, (errMat, rMat) => {
                                        db.query(qSchemeMix, (errMix, rMix) => {
                                            db.query(qSalesDays, (errSales, rSales) => {
                                                const totalRevenue = (rRev && rRev[0]) ? parseFloat(rRev[0].totalRevenue) : 0;
                                                const goldGrams = (rGold && rGold[0]) ? parseFloat(rGold[0].goldGrams) : 0;
                                                const silverGrams = (rSilver && rSilver[0]) ? parseFloat(rSilver[0].silverGrams) : 0;
                                                const schemeCollections = (rScheme && rScheme[0]) ? parseFloat(rScheme[0].schemeCollections) : 0;
                                                const pendingVerification = (rKyc && rKyc[0]) ? parseInt(rKyc[0].pendingKyc, 10) : 0;
                                                
                                                const enrolledUsers = (rUsers && rUsers[0]) ? rUsers[0].enrolledUsers : 0;
                                                const totalUsers = (rUsers && rUsers[0]) ? rUsers[0].totalUsers : 0;
                                                const activeSubscriptions = (rSubs && rSubs[0]) ? rSubs[0].activeSubscriptions : 0;
                                                const monthlyCapital = (rCap && rCap[0]) ? parseFloat(rCap[0].monthlyCapital) : 0;
                                                const forecastMaturity = (rMat && rMat[0]) ? parseFloat(rMat[0].forecastMaturity) : 0;

                                                const palette = ["#D4AF37", "#3B82F6", "#10B981", "#8B5CF6", "#F59E0B", "#EC4899"];
                                                const schemeDistribution = (rMix || []).map((row, idx) => ({
                                                    name: row.name,
                                                    value: Number(row.value),
                                                    amount: parseFloat(row.total_amount),
                                                    color: palette[idx % palette.length]
                                                }));

                                                // Build 7-day sales curve with real data
                                                const dayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
                                                const dayMap = {};
                                                dayOrder.forEach(d => { dayMap[d] = { label: d, gold: 0, silver: 0, schemes: 0, total: 0 }; });

                                                (rSales || []).forEach(row => {
                                                    const lbl = row.label;
                                                    if (dayMap[lbl]) {
                                                        dayMap[lbl].gold += parseFloat(row.gold);
                                                        dayMap[lbl].silver += parseFloat(row.silver);
                                                        dayMap[lbl].schemes += parseFloat(row.schemes);
                                                        dayMap[lbl].total += parseFloat(row.total);
                                                    }
                                                });

                                                const sales7d = dayOrder.map(d => dayMap[d]);

                                                res.json({
                                                    success: true,
                                                    totalRevenue,
                                                    total_revenue: totalRevenue,
                                                    goldGrams,
                                                    gold_grams: goldGrams,
                                                    silverGrams,
                                                    silver_grams: silverGrams,
                                                    schemeCollections,
                                                    scheme_collections: schemeCollections,
                                                    pendingVerification,
                                                    pending_verification: pendingVerification,
                                                    enrolledUsers,
                                                    enrolled_users: enrolledUsers,
                                                    totalUsers,
                                                    total_users: totalUsers,
                                                    activeSubscriptions,
                                                    active_subscriptions: activeSubscriptions,
                                                    monthlyCapital,
                                                    monthly_capital: monthlyCapital,
                                                    forecastMaturity,
                                                    forecast_maturity: forecastMaturity,
                                                    schemeDistribution,
                                                    scheme_distribution: schemeDistribution,
                                                    salesSeries: {
                                                        today: sales7d.slice(-2),
                                                        "7d": sales7d,
                                                        "1m": sales7d,
                                                        "1y": sales7d
                                                    }
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// Add Scheme
app.post('/api/schemes', (req, res) => {
    const {
        name,
        metalType, metal_type,
        durationMonths, duration_months, tenureMonths, tenure_months,
        bonusMonths, bonus_months,
        minMonthlyInstallment, min_monthly_installment,
        maxMonthlyInstallment, max_monthly_installment,
        bonusText, bonus_text, incentiveStructure,
        termsAndConditions, terms_and_conditions, description,
        isActive, is_active
    } = req.body;

    const finalName = name || 'New Scheme';
    const finalMetalType = metalType || metal_type || 'Gold';
    const finalDuration = durationMonths || duration_months || tenureMonths || tenure_months || 11;
    const finalBonusMonths = bonusMonths !== undefined ? bonusMonths : (bonus_months !== undefined ? bonus_months : 1);
    const finalMinInst = minMonthlyInstallment || min_monthly_installment || 1000.00;
    const finalMaxInst = maxMonthlyInstallment || max_monthly_installment || 50000.00;
    const finalBonusText = bonusText || bonus_text || incentiveStructure || '';
    const finalTerms = termsAndConditions || terms_and_conditions || description || '';
    const finalActive = isActive !== undefined ? (isActive ? 1 : 0) : (is_active !== undefined ? (is_active ? 1 : 0) : 1);

    const query = `INSERT INTO schemes
        (name, metal_type, duration_months, tenure_months, bonus_months, min_monthly_installment, max_monthly_installment, bonus_text, terms_and_conditions, description, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(query, [
        finalName,
        finalMetalType,
        finalDuration,
        finalDuration,
        finalBonusMonths,
        finalMinInst,
        finalMaxInst,
        finalBonusText,
        finalTerms,
        finalTerms,
        finalActive
    ], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        res.status(201).json({
            id: result.insertId,
            name: finalName,
            metalType: finalMetalType,
            durationMonths: finalDuration,
            tenureMonths: finalDuration,
            bonusMonths: finalBonusMonths,
            minMonthlyInstallment: finalMinInst,
            maxMonthlyInstallment: finalMaxInst,
            bonusText: finalBonusText,
            termsAndConditions: finalTerms,
            description: finalTerms,
            isActive: finalActive === 1
        });
    });
});

// Delete Scheme
app.delete('/api/schemes/:id', (req, res) => {
    db.query('DELETE FROM schemes WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ message: "Database error." });
        res.status(200).json({ message: "Scheme deleted successfully" });
    });
});

// H. Fetch Jewellery Catalogue (Direct Alias to /api/products)
app.get('/api/jewellery', (req, res) => {
    const query = `
        SELECT
            p.id,
            p.name,
            p.category_id,
            c.name AS category_name,
            p.image_url,
            p.price,
            p.stock_quantity,
            p.description
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        ORDER BY p.id DESC
    `;
    db.query(query, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Database error." });
        }
        const mapped = results.map(row => ({
            id: row.id,
            name: row.name,
            category: row.category_name || 'General',
            categoryName: row.category_name || 'General',
            categoryId: row.category_id,
            imageUrl: row.image_url || '',
            image_url: row.image_url || '',
            price: parseFloat(row.price || 0.00),
            stockQuantity: row.stock_quantity || 0,
            purity: '24K',
            grossWeight: 0.00,
            gross_weight: 0.00,
            makingChargesPercent: 0.00,
            description: row.description || ''
        }));
        res.status(200).json(mapped);
    });
});

app.post('/api/jewellery', upload.single('image'), (req, res) => {
    res.redirect(307, '/api/products');
});

app.delete('/api/jewellery/:id', (req, res) => {
    db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ message: "Database error." });
        res.status(200).json({ message: "Product deleted successfully" });
    });
});

// --- 4. Start Server ---
// const PORT = 8080;
// app.listen(PORT, '0.0.0.0', () => {
//     console.log(`Backend Server running on port ${PORT}`);
// });

//here i use dynamic port that allocate to my backend in railway
// ✅ Allow Railway's dynamic PORT:
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend Server running on port ${PORT}`);
});
