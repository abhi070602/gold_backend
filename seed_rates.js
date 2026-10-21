const mysql = require('mysql2');
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'gold_db'
});

db.connect(err => {
    if (err) {
        console.error("Conn err:", err);
        process.exit(1);
    }
    const createTable = `
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
    `;
    db.query(createTable, (err) => {
        if (err) console.error("Create err:", err);
        db.query('SELECT COUNT(*) AS cnt FROM metal_rates', (err, rows) => {
            if (err) console.error("Select err:", err);
            else console.log("Rows count:", rows[0].cnt);

            if (rows && rows[0].cnt === 0) {
                const seed = `
                    INSERT INTO metal_rates (metal_type, purity, title, buy_price_per_gram, sell_price_per_gram) VALUES
                    ('GOLD', '24K', '24K Pure Gold (99.9%)', 6500.00, 6380.00),
                    ('GOLD', '22K', '22K Standard Gold (91.6%)', 5960.00, 5840.00),
                    ('GOLD', '18K', '18K Jewellery Gold (75.0%)', 4880.00, 4780.00),
                    ('SILVER', '99.9%', '99.9% Fine Silver', 85.00, 83.30),
                    ('SILVER', '92.5%', '92.5% Sterling Silver', 78.60, 77.00);
                `;
                db.query(seed, (err) => {
                    if (err) console.error("Seed err:", err);
                    else console.log("Seeded 5 varieties!");
                    process.exit(0);
                });
            } else {
                process.exit(0);
            }
        });
    });
});