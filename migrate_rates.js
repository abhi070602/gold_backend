const mysql = require('mysql2');
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'gold_db'
});

db.connect(err => {
    if (err) {
        console.error("Connection error:", err);
        process.exit(1);
    }

    const alterQueries = [
        "ALTER TABLE metal_rates ADD COLUMN metal_type VARCHAR(50) DEFAULT 'GOLD'",
        "ALTER TABLE metal_rates ADD COLUMN purity VARCHAR(50) DEFAULT '24K'",
        "ALTER TABLE metal_rates ADD COLUMN title VARCHAR(100) DEFAULT '24K Pure Gold'",
        "ALTER TABLE metal_rates ADD COLUMN buy_price_per_gram DECIMAL(10, 2) DEFAULT 0.00",
        "ALTER TABLE metal_rates ADD COLUMN sell_price_per_gram DECIMAL(10, 2) DEFAULT 0.00",
        "ALTER TABLE metal_rates ADD COLUMN is_active TINYINT(1) DEFAULT 1"
    ];

    let completed = 0;
    alterQueries.forEach(q => {
        db.query(q, () => {
            completed++;
            if (completed === alterQueries.length) {
                // Delete dummy old test rows and insert clean variety rows
                db.query('TRUNCATE TABLE metal_rates', () => {
                    const seed = `
                        INSERT INTO metal_rates (metal_type, purity, title, buy_price_per_gram, sell_price_per_gram, is_active) VALUES
                        ('GOLD', '24K', '24K Pure Gold (99.9%)', 6500.00, 6380.00, 1),
                        ('GOLD', '22K', '22K Standard Gold (91.6%)', 5960.00, 5840.00, 1),
                        ('GOLD', '18K', '18K Jewellery Gold (75.0%)', 4880.00, 4780.00, 1),
                        ('SILVER', '99.9%', '99.9% Fine Silver', 85.00, 83.30, 1),
                        ('SILVER', '92.5%', '92.5% Sterling Silver', 78.60, 77.00, 1);
                    `;
                    db.query(seed, (err) => {
                        if (err) console.error("Seed error:", err);
                        else console.log("Seeded clean metal rates varieties!");
                        process.exit(0);
                    });
                });
            }
        });
    });
});