const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

// Criar conexão com o banco de dados
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err);
    } else {
        console.log('Conectado ao banco de dados SQLite');
        initializeDatabase();
    }
});

// Função para inicializar o banco de dados
async function initializeDatabase() {
    // Criar tabela de usuários
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'visitor',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, async (err) => {
        if (err) {
            console.error('Erro ao criar tabela de usuários:', err);
            return;
        }
        console.log('Tabela de usuários criada ou já existente');

        // Verificar se já existe um administrador
        db.get("SELECT * FROM users WHERE email = ?", ['erickafram08@gmail.com'], async (err, user) => {
            if (err) {
                console.error('Erro ao verificar administrador:', err);
                return;
            }

            if (!user) {
                // Criar usuário administrador padrão
                const hashedPassword = await bcrypt.hash('@@2025@@123', 10);
                db.run(`INSERT INTO users (name, email, phone, password, role) 
                       VALUES (?, ?, ?, ?, ?)`,
                    ['Erick Vinicius', 'erickafram08@gmail.com', '(00) 00000-0000', hashedPassword, 'admin'],
                    (err) => {
                        if (err) {
                            console.error('Erro ao criar administrador:', err);
                        } else {
                            console.log('Usuário administrador criado com sucesso');
                        }
                    });
            }
        });
    });

    // Criar tabela de artigos
    db.run(`CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        article_id TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        content TEXT NOT NULL,
        tags TEXT,
        keyword TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        html TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`, (err) => {
        if (err) {
            console.error('Erro ao criar tabela de artigos:', err);
        } else {
            console.log('Tabela de artigos criada ou já existente');
        }
    });
}

module.exports = db; 