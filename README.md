🚀 SEO Analyzer & Content Creator
Um sistema completo de análise de SEO e criação de conteúdo usando IA, desenvolvido em Node.js com interface web moderna.

✨ Funcionalidades
💬 Chat Geral: Converse com a IA sobre qualquer assunto
🔍 Análise SEO: Analise sites completos e receba sugestões de melhoria
✍️ Reescrita de Conteúdo: Extraia e reescreva artigos evitando plágio
📰 Criação de Matérias: Crie matérias jornalísticas baseadas em palavras-chave
🛠️ Tecnologias Utilizadas
Backend: Node.js + Express
Scraping: Puppeteer + Cheerio + Axios
IA: Together AI (Llama 3.3 70B)
APIs de Notícias: News API + GNews API
Frontend: HTML5 + CSS3 + JavaScript
📋 Pré-requisitos
Node.js 16+ instalado
Conexão com internet
Navegador moderno
🚀 Instalação
1. Clone/Baixe o projeto
Crie uma pasta para o projeto e salve os arquivos fornecidos.

2. Instale as dependências
bash
npm install
3. Configure as APIs (Opcional mas Recomendado)
News API (Gratuita)
Visite https://newsapi.org/
Registre-se gratuitamente
Copie sua API key
Substitua SUA_NEWS_API_KEY no arquivo server.js
GNews API (Gratuita)
Visite https://gnews.io/
Registre-se gratuitamente
Copie sua API key
Substitua SUA_GNEWS_API_KEY no arquivo server.js
Nota: O sistema funcionará mesmo sem essas APIs, usando dados de demonstração.

4. Estrutura dos arquivos
projeto/
├── server.js          # Servidor backend
├── package.json       # Dependências
├── public/
│   └── index.html     # Interface web
└── README.md          # Este arquivo
5. Execute o projeto
bash
npm start
Ou para desenvolvimento com auto-reload:

bash
npm run dev
6. Acesse o sistema
Abra seu navegador e visite: http://localhost:3000

🎯 Como Usar
Chat Geral
Digite qualquer pergunta no chat
A IA responderá usando o modelo Llama 3.3 70B
Análise SEO
Clique na aba "🔍 Análise SEO"
Digite a URL do site que deseja analisar
Clique em "Analisar"
Receba dados detalhados e sugestões de melhoria
Reescrever Conteúdo
Clique na aba "✍️ Reescrever"
Digite a URL do artigo
Escolha o tom desejado
Clique em "Reescrever"
Receba o conteúdo original e a versão reescrita
Criar Matéria
Clique na aba "📰 Criar Matéria"
Digite uma palavra-chave
Escolha o tom jornalístico
Clique em "Criar Matéria"
Receba uma matéria original baseada em notícias atuais
🔧 Configurações Avançadas
Modificar o modelo de IA
No arquivo server.js, linha 13, você pode alterar o modelo:

javascript
model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
Ajustar parâmetros da IA
javascript
max_tokens: 2000,    // Máximo de tokens na resposta
temperature: 0.7     // Criatividade (0.0 a 1.0)
Configurar Puppeteer (para análise SEO)
Se estiver em um servidor Linux, pode precisar instalar dependências:

bash
sudo apt-get update
sudo apt-get install -y chromium-browser
🌐 APIs Gratuitas Recomendadas
Para Notícias
News API (https://newsapi.org/)
1000 requests/dia grátis
Cobertura global
Múltiplas linguagens
GNews API (https://gnews.io/)
100 requests/dia grátis
Rápido e confiável
Sem necessidade de cartão
Para Web Scraping (já incluído)
Puppeteer: Scraping avançado com JavaScript
Cheerio: Parser HTML rápido
Axios: Requests HTTP simples
🔐 Segurança
Nunca exponha suas API keys no frontend
Use variáveis de ambiente em produção
Implemente rate limiting se necessário
Valide todas as URLs de entrada
📝 Exemplo de Uso com Variáveis de Ambiente
Crie um arquivo .env:

env
TOGETHER_API_KEY=sua_chave_together
NEWS_API_KEY=sua_chave_news_api
GNEWS_API_KEY=sua_chave_gnews
PORT=3000
Instale dotenv:

bash
npm install dotenv
Modifique o início do server.js:

javascript
require('dotenv').config();

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
🚀 Deploy
Heroku
Instale Heroku CLI
Configure buildpack do Puppeteer:
bash
heroku buildpacks:add jontewks/puppeteer
Vercel
Configure as variáveis de ambiente
Use o buildpack apropriado para Puppeteer
VPS/Servidor
Configure PM2 para gerenciamento de processos
Configure nginx como proxy reverso
Configure SSL com Let's Encrypt
🐛 Solução de Problemas
Puppeteer não funciona
bash
# Linux
sudo apt-get install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget

# Docker
FROM node:16-slim
RUN apt-get update && apt-get install -y wget gnupg
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
RUN sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
RUN apt-get update && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends
Erro de CORS
Certifique-se de que o CORS está configurado corretamente no servidor.

Limite de API atingido
Use cache para requests repetidos
Implemente fallbacks para dados mock
Configure múltiplas APIs como backup
📊 Monitoramento
Adicione logs para monitorar o uso:

javascript
console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
🤝 Contribuição
Fork o projeto
Crie uma branch para sua feature
Commit suas mudanças
Push para a branch
Abra um Pull Request
📄 Licença
Este projeto está sob a licença MIT. Veja o arquivo LICENSE para detalhes.

🆘 Suporte
Se precisar de ajuda:

Verifique este README primeiro
Procure por issues similares
Abra uma nova issue com detalhes do problema
Desenvolvido com ❤️ usando Node.js e IA

# Gestor de Postagens com Integração WordPress

## Configuração da Integração com WordPress

Para configurar a integração com WordPress e permitir a publicação automática de matérias:

### 1. Criar uma Senha de Aplicativo no WordPress

1. Acesse o painel administrativo do seu WordPress
2. Vá para **Usuários** → **Seu Perfil**
3. Role até a seção **Senhas de Aplicativo** (se não encontrar, instale o plugin "Application Passwords")
4. Em "Nome da Senha de Aplicativo", digite "Gestor de Postagens"
5. Clique em "Adicionar Nova Senha de Aplicativo"
6. **IMPORTANTE**: Copie a senha gerada, pois ela será exibida apenas uma vez

### 2. Configurar a Integração no Aplicativo

1. No aplicativo Gestor de Postagens, clique em "⚙️ Configurações WordPress"
2. Preencha os campos:
   - **URL do Site WordPress**: URL completa do seu site (ex: https://seusite.com.br)
   - **Nome de usuário**: Seu nome de usuário no WordPress
   - **Senha de aplicativo**: Cole a senha de aplicativo gerada anteriormente
   - **Categoria padrão**: ID da categoria onde os posts serão publicados (padrão: 1)
   - **Status padrão de publicação**: Escolha entre "Rascunho" ou "Publicado"
3. Clique em "Testar Conexão" para verificar se tudo está funcionando
4. Salve as configurações

### 3. Publicar Conteúdo

Após criar ou reescrever uma matéria:
1. Clique no botão "Publicar no WordPress"
2. Verifique os detalhes da publicação
3. Clique em "Publicar no WordPress" para finalizar

### Solução de Problemas

- **Erro de conexão**: Verifique se a URL está correta e inclui "https://"
- **Falha na autenticação**: Confirme seu nome de usuário e gere uma nova senha de aplicativo
- **Erro ao publicar**: Verifique se o usuário tem permissões para criar posts

