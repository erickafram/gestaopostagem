const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const FormData = require('form-data');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { pipeline } = require('@xenova/transformers');
const WaveFile = require('wavefile').WaveFile;
require('dotenv').config();
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const db = require('./database');
const bcrypt = require('bcryptjs');

// Configurações da API
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || 'e47a6140dcb84c25812378315e859125';
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || '8f2666a67bee6b36fbc09d507c0b2e4e4059ae3c3a78672448eefaf248cd673b';
const TOGETHER_API_URL = 'https://api.together.xyz/v1/chat/completions';
const NEWS_API_KEY = process.env.NEWS_API_KEY || '2e4ccaf2ce06439e8639c4e7bd773026'; // Obtenha gratuitamente em https://newsapi.org/
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || '9d7d67d643271718fc84dc18d14fc878'; // Obtenha gratuitamente em https://gnews.io/

// Função para criar timeout em promises
function withTimeout(promise, timeoutMs, errorMessage) {
    return Promise.race([
        promise,
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
        )
    ]);
}

// Configure o FFmpeg
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

console.log('FFmpeg configurado:', ffmpegPath);
console.log('FFprobe configurado:', ffprobePath);

// Definir pasta para downloads temporários
const TEMP_DIR = './temp_downloads';

// Verificar se a pasta de downloads temporários existe e criar se necessário
if (!fsSync.existsSync(TEMP_DIR)) {
    fsSync.mkdirSync(TEMP_DIR, { recursive: true });
    console.log(`Pasta de downloads temporários criada: ${TEMP_DIR}`);
}

// Função para verificar dependências do sistema
async function checkDependencies() {
    const dependencies = [];
    
    // Verificar FFmpeg
    try {
        await checkFFmpegAvailability();
        console.log('✓ FFmpeg disponível');
    } catch (error) {
        dependencies.push('FFmpeg não está disponível para processamento de vídeo');
    }
    
    // Verificar yt-dlp
    try {
        const testWrap = new YTDlpWrap();
        console.log('✓ yt-dlp disponível');
    } catch (error) {
        dependencies.push('yt-dlp não está disponível para download de vídeos');
    }
    
    if (dependencies.length > 0) {
        console.warn('⚠️  Dependências em falta:');
        dependencies.forEach(dep => console.warn(`   - ${dep}`));
    }
}

// Chamar verificação ao iniciar o servidor
checkDependencies();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Configuração da sessão
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: './'
    }),
    secret: 'sua_chave_secreta_aqui',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Definir como true em produção com HTTPS
        maxAge: 1000 * 60 * 60 * 24 // 24 horas
    }
}));

// Middleware para verificar autenticação
function requireAuth(req, res, next) {
    console.log('Verificando autenticação:', {
        sessionExists: !!req.session,
        userId: req.session?.userId,
        sessionId: req.session?.id
    });
    
    if (req.session && req.session.userId) {
        next();
    } else {
        console.error('Acesso não autorizado: Usuário não autenticado');
        res.status(401).json({ message: 'Não autorizado. Faça login novamente.' });
    }
}

// Middleware para redirecionar usuários não autenticados para a página de login
function checkAuth(req, res, next) {
    // Permitir acesso a login.html, register.html e rotas de API sem autenticação
    if (
        req.path === '/login.html' || 
        req.path === '/register.html' || 
        req.path.startsWith('/api/login') || 
        req.path.startsWith('/api/register') ||
        req.path.startsWith('/js/') ||
        req.path.startsWith('/css/') ||
        req.path.startsWith('/img/')
    ) {
        return next();
    }
    
    // Verificar se o usuário está autenticado
    if (req.session && req.session.userId) {
        return next();
    }
    
    // Se o usuário não estiver autenticado e estiver tentando acessar index.html ou a raiz
    if (req.path === '/index.html' || req.path === '/') {
        return res.redirect('/login.html');
    }
    
    // Para solicitações de API, retornar erro 401
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ message: 'Não autorizado' });
    }
    
    // Para outras páginas, redirecionar para login
    return res.redirect('/login.html');
}

// Aplicar middleware de verificação antes de servir arquivos estáticos
app.use(checkAuth);
app.use(express.static('public'));

// Rota de login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
            if (err) {
                console.error('Erro ao buscar usuário:', err);
                return res.status(500).json({ message: 'Erro interno do servidor' });
            }

            if (!user) {
                return res.status(401).json({ message: 'Email ou senha incorretos' });
            }

            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                return res.status(401).json({ message: 'Email ou senha incorretos' });
            }

            // Criar sessão
            req.session.userId = user.id;
            req.session.userRole = user.role;

            res.json({
                message: 'Login realizado com sucesso',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role
                }
            });
        });
    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ message: 'Erro ao realizar login' });
    }
});

// Rota de registro
app.post('/api/register', async (req, res) => {
    const { name, email, phone, password } = req.body;

    try {
        // Verificar se o email já existe
        db.get('SELECT id FROM users WHERE email = ?', [email], async (err, existingUser) => {
            if (err) {
                console.error('Erro ao verificar email:', err);
                return res.status(500).json({ message: 'Erro interno do servidor' });
            }

            if (existingUser) {
                return res.status(400).json({ message: 'Email já cadastrado' });
            }

            // Criar novo usuário
            const hashedPassword = await bcrypt.hash(password, 10);
            db.run(
                'INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, ?)',
                [name, email, phone, hashedPassword, 'visitor'],
                function(err) {
                    if (err) {
                        console.error('Erro ao criar usuário:', err);
                        return res.status(500).json({ message: 'Erro ao criar usuário' });
                    }

                    res.json({
                        message: 'Usuário criado com sucesso',
                        userId: this.lastID
                    });
                }
            );
        });
    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({ message: 'Erro ao registrar usuário' });
    }
});

// Rota de logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Erro ao fazer logout:', err);
            return res.status(500).json({ message: 'Erro ao fazer logout' });
        }
        res.json({ message: 'Logout realizado com sucesso' });
    });
});

// Rota para verificar autenticação
app.get('/api/check-auth', (req, res) => {
    if (req.session && req.session.userId) {
    db.get('SELECT id, name, email, role FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (err) {
            console.error('Erro ao buscar usuário:', err);
            return res.status(500).json({ message: 'Erro interno do servidor' });
        }

        if (!user) {
                // Sessão inválida
            req.session.destroy();
                return res.status(401).json({ authenticated: false });
        }

        res.json({
            authenticated: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });
    });
    } else {
        res.json({ authenticated: false });
    }
});

// Armazenar conexões SSE ativas
const clients = {};
let clientIdCounter = 0;

// Middleware para SSE (Server-Sent Events)
app.get('/api/progress-events', (req, res) => {
    const clientId = clientIdCounter++;
    
    // Configurar cabeçalhos para SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
    // Enviar um evento inicial
    res.write(`data: {"event": "connected", "message": "Conectado ao servidor de eventos"}\n\n`);
    
    // Armazenar a conexão
    clients[clientId] = res;
    
    // Limpar a conexão quando o cliente desconectar
    req.on('close', () => {
        delete clients[clientId];
    });
});

// Função para enviar evento de progresso para todos os clientes
function sendProgressEvent(event, message) {
    const data = JSON.stringify({ event, message });
    Object.values(clients).forEach(client => {
        client.write(`data: ${data}\n\n`);
    });
}

// Função para chamar a API do Together
async function callTogetherAPI(prompt, modelOverride = null) {
    try {
        console.log("Enviando prompt para a API:", prompt.substring(0, 100) + "...");
        
        // Determinar qual modelo usar
        let model = 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo'; // Modelo padrão
        
        // Verificar se é uma solicitação de edição de matéria para o Assistente IA
        if (prompt.includes("assistente de edição de texto especializado em matérias jornalísticas") || 
            (modelOverride === 'deepseek' || 
             prompt.includes("Editando Matéria") || 
             prompt.includes("PARTE A SER EDITADA"))) {
            model = 'deepseek-ai/DeepSeek-V3';
            console.log("Usando modelo DeepSeek-V3 para edição de matéria");
        } else if (modelOverride) {
            model = modelOverride;
            console.log(`Usando modelo especificado: ${model}`);
        }
        
        const response = await axios.post(TOGETHER_API_URL, {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 4000,
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${TOGETHER_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        const responseContent = response.data.choices[0].message.content;
        console.log("Resposta da API recebida:", responseContent.substring(0, 100) + "...");
        return responseContent;
    } catch (error) {
        console.error('Erro na API Together:', error.response?.data || error.message);
        throw new Error('Erro ao processar solicitação da IA');
    }
}

// Função para analisar SEO de um site
async function analyzeSEO(url) {
    try {
        // Use a configuração headless:"new" como recomendado na mensagem de deprecated
        const browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // Aumentar o timeout para navegação para 60 segundos
        await page.setDefaultNavigationTimeout(60000);
        
        // Configurar timeout para espera de elementos
        await page.setDefaultTimeout(60000);
        
        console.log(`Analisando SEO para: ${url}`);
        
        // Ir para a URL especificada e esperar que a rede esteja praticamente inativa
        await page.goto(url, { 
            waitUntil: 'networkidle2',  // Mudar de networkidle0 para networkidle2 (mais rápido, considera carregado quando há no máximo 2 conexões)
            timeout: 60000  // 60 segundos de timeout
        });
        
        // Extração de dados SEO
        const seoData = await page.evaluate(() => {
            return {
                title: document.title || '',
                metaDescription: document.querySelector('meta[name="description"]')?.content || '',
                metaKeywords: document.querySelector('meta[name="keywords"]')?.content || '',
                h1Tags: Array.from(document.querySelectorAll('h1')).map(h1 => h1.textContent.trim()),
                h2Tags: Array.from(document.querySelectorAll('h2')).map(h2 => h2.textContent.trim()),
                images: Array.from(document.querySelectorAll('img')).map(img => ({
                    src: img.src,
                    alt: img.alt || 'Sem alt text'
                })),
                links: Array.from(document.querySelectorAll('a')).length,
                internalLinks: Array.from(document.querySelectorAll('a')).filter(a => 
                    a.href && a.href.includes(window.location.hostname)
                ).length,
                externalLinks: Array.from(document.querySelectorAll('a')).filter(a => 
                    a.href && !a.href.includes(window.location.hostname) && a.href.startsWith('http')
                ).length,
                textContent: document.body.innerText.length,
                loadTime: performance.timing ? (performance.timing.loadEventEnd - performance.timing.navigationStart) : 0
            };
        });
        
        await browser.close();
        console.log("Análise SEO concluída com sucesso");
        return seoData;
    } catch (error) {
        console.error('Erro na análise SEO:', error);
        throw new Error('Erro ao analisar o site: ' + error.message);
    }
}

// Função para detectar se é URL do Instagram
function isInstagramUrl(url) {
    return url.includes('instagram.com/p/') || 
           url.includes('instagram.com/reel/') ||
           url.includes('instagram.com/tv/');
}

// Função para verificar disponibilidade do FFmpeg
async function checkFFmpegAvailability() {
    try {
        // Verificar se ffprobe está disponível
        await new Promise((resolve, reject) => {
            ffmpeg.ffprobe('test', (err) => {
                if (err && err.message.includes('No such file')) {
                    resolve(); // FFprobe está disponível, só não encontrou o arquivo teste
                } else if (err && err.message.includes('Cannot find ffprobe')) {
                    reject(new Error('FFprobe não está disponível'));
                } else {
                    resolve();
                }
            });
        });
        
        console.log('FFmpeg/FFprobe verificado com sucesso');
        return true;
    } catch (error) {
        console.error('FFmpeg não disponível:', error.message);
        return false;
    }
}

// Função para limpar repetições na transcrição
function cleanTranscription(text) {
    if (!text || text.trim() === '') return '';
    
    // Remover repetições óbvias de frases
    let cleaned = text;
    
    // Dividir em frases
    const sentences = cleaned.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
    
    // Remover frases muito repetitivas
    const uniqueSentences = [];
    const seenSentences = new Set();
    
    for (const sentence of sentences) {
        // Normalizar frase para comparação
        const normalized = sentence.toLowerCase().replace(/[^a-záêçõ\s]/g, '').trim();
        
        // Se a frase não foi vista antes ou é muito diferente
        if (!seenSentences.has(normalized) && normalized.length > 5) {
            seenSentences.add(normalized);
            uniqueSentences.push(sentence);
        }
    }
    
    // Reconstruir texto
    cleaned = uniqueSentences.join('. ');
    
    // Remover repetições de palavras consecutivas
    cleaned = cleaned.replace(/\b(\w+)(\s+\1){3,}/gi, '$1');
    
    // Limpar espaços extras
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
}

// Função para extrair informações do áudio E fazer transcrição (versão otimizada e rápida)
async function extractAudioInfo(audioPath) {
    try {
        console.log('Analisando informações do áudio...');
        sendProgressEvent('audio_analysis_start', 'Analisando áudio do vídeo...');
        
        // Verificar se o arquivo de áudio existe
        if (!fsSync.existsSync(audioPath)) {
            throw new Error(`Arquivo de áudio não encontrado: ${audioPath}`);
        }
        
        // Usar ffmpeg para obter informações sobre o áudio
        const audioInfo = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(audioPath, (err, metadata) => {
                if (err) {
                    return reject(err);
                }
                
                const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                
                if (!audioStream) {
                    return resolve({
                        duration: metadata.format.duration || 'Desconhecida',
                        bitrate: metadata.format.bit_rate ? Math.round(metadata.format.bit_rate / 1000) + ' kbps' : 'Desconhecido',
                        format: metadata.format.format_name || 'Desconhecido',
                        hasAudio: false
                    });
                }
                
                resolve({
                    duration: metadata.format.duration || 'Desconhecida',
                    bitrate: audioStream.bit_rate ? Math.round(audioStream.bit_rate / 1000) + ' kbps' : 'Desconhecido',
                    sampleRate: audioStream.sample_rate ? audioStream.sample_rate + ' Hz' : 'Desconhecido',
                    channels: audioStream.channels || 'Desconhecido',
                    codec: audioStream.codec_name || 'Desconhecido',
                    format: metadata.format.format_name || 'Desconhecido',
                    hasAudio: true
                });
            });
        });
        
        console.log('Informações do áudio:', audioInfo);
        
        // Se tem áudio, fazer transcrição com AssemblyAI
        let transcription = '';
        if (audioInfo.hasAudio) {
            try {
                console.log('Iniciando transcrição com AssemblyAI...');
                sendProgressEvent('audio_transcription', 'Transcrevendo áudio com AssemblyAI...');
                
                // Tentar transcrição com AssemblyAI primeiro
                transcription = await transcribeWithAssemblyAI(audioPath);
                
                // Se a transcrição estiver vazia ou falhar, tentar o fallback
                if (!transcription || transcription.trim() === '') {
                    console.log('Transcrição AssemblyAI vazia, tentando fallback...');
                    sendProgressEvent('audio_transcription', 'Tentando transcrição alternativa...');
                    transcription = await simpleAudioTranscription(audioPath);
                }
                
                // Se ainda estiver vazia, usar mensagem genérica
                if (!transcription || transcription.trim() === '') {
                    const duration = audioInfo.duration;
                    if (duration && typeof duration === 'number') {
                        if (duration < 30) {
                            transcription = '[Áudio muito curto ou sem fala clara detectada]';
                        } else if (duration > 300) {
                            transcription = '[Áudio muito longo ou sem fala clara detectada]';
                        } else {
                            transcription = '[Não foi possível detectar fala clara no áudio]';
                        }
                    }
                }
                
                console.log('Transcrição concluída:', transcription ? transcription.substring(0, 100) + '...' : '[vazia]');
                sendProgressEvent('transcription_complete', 'Transcrição de áudio concluída!');
                
            } catch (transcriptionError) {
                console.error('Erro na transcrição:', transcriptionError);
                transcription = `[Erro na transcrição: ${transcriptionError.message}]`;
            }
        }
        
        return {
            audioInfo,
            transcription: transcription || '[Sem transcrição disponível]',
            message: audioInfo.hasAudio ? 
                `Áudio processado (${typeof audioInfo.duration === 'number' ? Math.round(audioInfo.duration) + 's' : audioInfo.duration}).` :
                `Sem áudio detectado.`
        };
        
    } catch (error) {
        console.error('Erro ao extrair informações do áudio:', error);
        return {
            audioInfo: { hasAudio: false },
            transcription: `[Erro no processamento: ${error.message}]`,
            message: `Erro no processamento de áudio: ${error.message}`
        };
    }
}

// Função de fallback para transcrição simples
async function simpleAudioTranscription(audioPath) {
    try {
        console.log('Iniciando transcrição de fallback...');
        
        // Criar versão super simplificada
        const simpleAudioPath = audioPath.replace('.wav', '_simple.wav');
                
        // Áudio com qualidade muito baixa para acelerar ao máximo
                await new Promise((resolve, reject) => {
                    ffmpeg(audioPath)
                .output(simpleAudioPath)
                        .audioCodec('pcm_s16le')
                .audioFrequency(8000) // Frequência muito baixa
                        .audioChannels(1)
                .audioBitrate('32k') // Bitrate muito baixo
                .duration(30) // Apenas os primeiros 30 segundos
                                .on('end', resolve)
                                .on('error', reject)
                        .run();
                });
                
        // Processar com modelo tiny
                const WaveFile = require('wavefile').WaveFile;
        const audioBuffer = await fs.readFile(simpleAudioPath);
                const wav = new WaveFile(audioBuffer);
                
                wav.toBitDepth('32f');
                const audioData = wav.getSamples();
                
                let samples;
                if (Array.isArray(audioData)) {
                    samples = new Float32Array(audioData[0].length);
                    for (let i = 0; i < audioData[0].length; i++) {
                        samples[i] = audioData[0][i];
                    }
                } else {
                    samples = audioData;
                }
                
                const { pipeline } = require('@xenova/transformers');
        const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
                
        const result = await Promise.race([
            transcriber(samples, {
                    language: 'portuguese',
                    task: 'transcribe',
                chunk_length_s: 10,
                    return_timestamps: false
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout no fallback')), 45000)
            )
        ]);
        
        // Limpar arquivo temporário
                try {
            await fs.unlink(simpleAudioPath);
                } catch (cleanupError) {
            console.warn('Erro ao limpar áudio simples:', cleanupError.message);
            }
        
        return result.text || '[Transcrição parcial não disponível]';
        
    } catch (error) {
        console.error('Erro no fallback de transcrição:', error);
        return '[Transcrição indisponível - áudio pode não conter fala clara]';
    }
}

// Função para baixar e processar vídeo do Instagram (versão otimizada)
async function downloadAndProcessInstagramVideo(url) {
    let videoPath = null;
    let audioPath = null;
    
    try {
        console.log('Iniciando download otimizado...');
        
        // Verificar FFmpeg com timeout curto
        const ffmpegAvailable = await Promise.race([
            checkFFmpegAvailability(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout FFmpeg')), 15000)
            )
        ]);
        
        if (!ffmpegAvailable) {
            throw new Error('FFmpeg não disponível');
        }
        
        // Verificar yt-dlp
        try {
            const testWrap = new YTDlpWrap();
            console.log('✓ yt-dlp disponível');
        } catch (checkError) {
            throw new Error('yt-dlp não disponível');
        }
        
        console.log('Baixando vídeo do Instagram (formato otimizado)...');
        sendProgressEvent('video_download_start', 'Baixando vídeo (versão rápida)...');
        
        const ytDlpWrap = new YTDlpWrap();
        const videoFileName = `instagram_video_${Date.now()}`;
        videoPath = `${TEMP_DIR}/${videoFileName}.%(ext)s`;
        audioPath = `${TEMP_DIR}/${videoFileName}.wav`;
        
        // Opções otimizadas para velocidade
        const ytDlpOptions = [
            '--format', 'worst[ext=mp4]/worst', // Usar qualidade mais baixa para acelerar
            '--output', videoPath,
            '--no-playlist',
            '--no-check-certificate',
            '--socket-timeout', '30', // Timeout de socket
            '--retries', '2', // Menos tentativas
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ];
        
        // Download com timeout
        const downloadResult = await Promise.race([
            ytDlpWrap.execPromise([url, ...ytDlpOptions]),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout no download')), 60000) // 1 minuto
            )
        ]);
        
        console.log('Download concluído, processando...');
        
        // Encontrar arquivo baixado
        const files = await fs.readdir(TEMP_DIR);
        const downloadedFile = files.find(file => 
            file.includes('instagram_video_') && 
            (file.endsWith('.mp4') || file.endsWith('.webm') || file.endsWith('.mkv'))
        );
        
        if (!downloadedFile) {
            throw new Error('Arquivo não encontrado após download');
        }
        
        const actualVideoPath = `${TEMP_DIR}/${downloadedFile}`;
        
        return await processDownloadedVideoFast(actualVideoPath, audioPath);
        
    } catch (error) {
        console.error('Erro no download/processamento:', error);
        
        // Limpar arquivos
        try {
            if (videoPath && fsSync.existsSync(videoPath.replace('.%(ext)s', '.mp4'))) {
                await fs.unlink(videoPath.replace('.%(ext)s', '.mp4'));
            }
            if (audioPath && fsSync.existsSync(audioPath)) {
                await fs.unlink(audioPath);
            }
        } catch (cleanupError) {
            console.warn('Erro na limpeza:', cleanupError.message);
        }
        
        throw error;
    }
}

// Função auxiliar para processar vídeo de forma rápida
async function processDownloadedVideoFast(videoPath, audioPath) {
    try {
        console.log('Processamento rápido do vídeo...');
        sendProgressEvent('video_processing', 'Processamento rápido...');
                
        // Obter informações básicas do vídeo
        const videoInfo = await Promise.race([
            new Promise((resolve, reject) => {
                ffmpeg.ffprobe(videoPath, (err, metadata) => {
                    if (err) return reject(err);
                    
                    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                    resolve({
                        width: videoStream?.width || 'N/A',
                        height: videoStream?.height || 'N/A',
                        duration: metadata.format.duration ? Math.round(metadata.format.duration) : 'N/A',
                        size: metadata.format.size ? `${Math.round(metadata.format.size / 1024 / 1024 * 100) / 100} MB` : 'N/A'
                    });
                });
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout info vídeo')), 15000)
            )
        ]);

        console.log('Extraindo áudio rapidamente...');
        sendProgressEvent('audio_extraction_start', 'Extração rápida de áudio...');
        
        // Extrair áudio com timeout
        await Promise.race([
            new Promise((resolve, reject) => {
                ffmpeg(videoPath)
                    .output(audioPath)
                    .audioCodec('pcm_s16le')
                    .audioFrequency(16000)
                    .audioChannels(1)
                    .noVideo()
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout extração áudio')), 30000)
            )
        ]);

        console.log('Áudio extraído, iniciando transcrição...');
        sendProgressEvent('transcription_start', 'Iniciando transcrição do áudio...');

        // Primeiro tentar com AssemblyAI
        let transcriptionResult = null;
        try {
            transcriptionResult = await transcribeWithAssemblyAI(audioPath);
            console.log('Transcrição AssemblyAI concluída:', transcriptionResult ? transcriptionResult.substring(0, 100) + '...' : '[vazia]');
        } catch (assemblyError) {
            console.error('Erro na transcrição AssemblyAI:', assemblyError);
            console.log('Tentando transcrição alternativa...');
            try {
                transcriptionResult = await simpleAudioTranscription(audioPath);
                console.log('Transcrição alternativa concluída:', transcriptionResult ? transcriptionResult.substring(0, 100) + '...' : '[vazia]');
            } catch (fallbackError) {
                console.error('Erro na transcrição alternativa:', fallbackError);
            }
        }
        
        sendProgressEvent('video_processing_complete', 'Processamento concluído!');

        // Limpar arquivos
        try {
                await fs.unlink(videoPath);
            if (fsSync.existsSync(audioPath)) {
                await fs.unlink(audioPath);
            }
        } catch (cleanupError) {
            console.warn('Erro na limpeza:', cleanupError.message);
        }
        
        return {
            videoInfo,
            audioInfo: {
                hasAudio: true,
                duration: videoInfo.duration,
                format: 'wav',
                channels: 1,
                sampleRate: '16000 Hz'
            },
            transcription: transcriptionResult || '[Transcrição não disponível]',
            infoMessage: `Vídeo: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration}s, ${videoInfo.size}.`,
            success: true
        };

    } catch (error) {
        console.error('Erro no processamento rápido:', error);
        return {
            videoInfo: { width: 'N/A', height: 'N/A', duration: 'N/A', size: 'N/A' },
            audioInfo: { hasAudio: false },
            transcription: `[Erro no processamento: ${error.message}]`,
            infoMessage: `Processamento falhou: ${error.message}`,
            success: false
        };
    }
}

async function processDownloadedVideo(videoPath, audioPath) {
    try {
        console.log('5. Iniciando processamento do vídeo...');
        sendProgressEvent('video_processing', 'Processando vídeo...');

        // Obter informações do vídeo
        const videoInfo = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) return reject(err);
                
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                resolve({
                    width: videoStream?.width || 'Desconhecido',
                    height: videoStream?.height || 'Desconhecido',
                    duration: metadata.format.duration ? Math.round(metadata.format.duration) : 'Desconhecida',
                    size: metadata.format.size ? `${Math.round(metadata.format.size / 1024 / 1024 * 100) / 100} MB` : 'Desconhecido'
                });
            });
        });

        console.log('6. Informações do vídeo obtidas:', videoInfo);

        // ADICIONAR: Extrair áudio do vídeo para arquivo WAV
        console.log('Extraindo áudio do vídeo...');
        sendProgressEvent('audio_extraction_start', 'Extraindo áudio do vídeo...');
        
        await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .output(audioPath)
                .audioCodec('pcm_s16le')
                .audioFrequency(16000)
                .audioChannels(1)
                .noVideo()
                .on('end', () => {
                    console.log('Áudio extraído com sucesso:', audioPath);
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Erro ao extrair áudio:', err);
                    reject(err);
                })
                .run();
        });

        // Analisar áudio com verificação de erro
        let audioResult;
        try {
            audioResult = await extractAudioInfo(audioPath);
        } catch (audioError) {
            console.error('Erro na análise de áudio:', audioError.message);
            audioResult = {
                audioInfo: { hasAudio: false },
                transcription: '',
                message: 'Erro ao processar áudio'
            };
        }

        console.log('7. Análise do áudio concluída');

        sendProgressEvent('video_processing_complete', 'Processamento de vídeo concluído!');

        // Limpar arquivos
        try {
            await fs.unlink(videoPath);
            if (fsSync.existsSync(audioPath)) {
                await fs.unlink(audioPath);
            }
            console.log('Arquivos temporários removidos');
        } catch (cleanupError) {
            console.warn('Erro ao limpar arquivos:', cleanupError.message);
        }

        return {
            videoInfo,
            audioInfo: audioResult.audioInfo || { hasAudio: false },
            transcription: audioResult.transcription || '',
            infoMessage: `Vídeo processado: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration} segundos, ${videoInfo.size}. ${audioResult.message || 'Processamento concluído'}`,
            success: true
        };

    } catch (error) {
        console.error('Erro no processamento:', error);
        return {
            videoInfo: {},
            audioInfo: { hasAudio: false },
            transcription: '',
            infoMessage: `Erro no processamento: ${error.message}`,
            success: false
        };
    }
}

// Função para extrair conteúdo do Instagram
// Função para extrair conteúdo do Instagram (VERSÃO COMPLETA COM TRANSCRIÇÃO DE VÍDEO)
async function extractInstagramContent(url, includeVideoTranscription = true) {
    try {
        console.log(`Extraindo conteúdo do Instagram: ${url}`);
        
        // Extrair ID do vídeo da URL
        const videoId = url.split('/p/')[1]?.split('/')[0] || 'unknown';
        
        // Usar Puppeteer para Instagram pois é SPA (Single Page Application)
        const browser = await puppeteer.launch({ 
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=VizDisplayCompositor',
                '--disable-web-security',
                '--disable-features=BlockInsecurePrivateNetworkRequests'
            ]
        });
        
        const page = await browser.newPage();
        
        // Configurar user agent para evitar detecção
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Configurar viewport
        await page.setViewport({ width: 1280, height: 720 });
        
        // Configurar timeout maior
        await page.setDefaultNavigationTimeout(60000);
        await page.setDefaultTimeout(60000);
        
        console.log('Navegando para a URL do Instagram...');
        
        // Ir para a URL e aguardar carregamento
        await page.goto(url, { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        console.log('Aguardando carregamento do conteúdo...');
        
        // CORREÇÃO: Usar setTimeout com Promise em vez de waitForTimeout
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Verificar se é vídeo/reel APENAS se includeVideoTranscription for true
        let isVideo = { hasVideo: false, isReel: false, isTv: false, isVideoContent: false };

        if (includeVideoTranscription) {
            isVideo = await page.evaluate(() => {
            // Verificar se há elementos de vídeo
            const videoElements = document.querySelectorAll('video');
            const isReel = window.location.href.includes('/reel/');
            const isTv = window.location.href.includes('/tv/');
            
            return {
                hasVideo: videoElements.length > 0,
                isReel: isReel,
                isTv: isTv,
                isVideoContent: videoElements.length > 0 || isReel || isTv
            };
        });
        
        console.log('Tipo de conteúdo detectado:', isVideo);
        }
        
        console.log('Tentando extrair dados...');
        
        // Extrair dados do Instagram
        const instagramData = await page.evaluate(() => {
            console.log('Executando extração no navegador...');
            
            // Extrair texto da postagem
            let postText = '';
            
            // Múltiplos seletores para texto da postagem
            const textSelectors = [
                // Seletores para texto de postagem
                'article div[data-testid="post-text"]',
                'article span[style*="line-height"]',
                'article div h1',
                'div[role="button"] span',
                'article span:not([role])',
                'span[dir="auto"]',
                'div[data-testid="post-text"] span',
                'article div span',
                // Para reels
                'div[role="dialog"] span',
                'div[style*="word-wrap"] span'
            ];
            
            // Tentar diferentes seletores
            for (const selector of textSelectors) {
                const elements = document.querySelectorAll(selector);
                for (const element of elements) {
                    const text = element.textContent.trim();
                    if (text.length > postText.length && text.length > 10) {
                        postText = text;
                    }
                }
            }
            
            // Se ainda não encontrou, tentar meta tags
            if (!postText || postText.length < 10) {
                const metaDesc = document.querySelector('meta[property="og:description"]');
                if (metaDesc) {
                    const metaContent = metaDesc.getAttribute('content') || '';
                    if (metaContent.length > 10) {
                        postText = metaContent;
                    }
                }
            }
            
            // Tentar extrair do JSON-LD
            if (!postText || postText.length < 10) {
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const script of scripts) {
                    try {
                        const data = JSON.parse(script.textContent);
                        if (data.description && data.description.length > 10) {
                            postText = data.description;
                            break;
                        }
                    } catch (e) {
                        // Ignorar erros de parsing
                    }
                }
            }
            
            // Extrair autor PRIMEIRO
            let author = '';
            const authorSelectors = [
                'article header a',
                'header span[dir="auto"]',
                'a[role="link"] span'
            ];

            for (const selector of authorSelectors) {
                const element = document.querySelector(selector);
                if (element && element.textContent.trim()) {
                    author = element.textContent.trim();
                    break;
                }
            }

            console.log('Autor extraído:', author);

            // AGORA extrair comentários (depois de ter o autor)
            const comments = [];
            const commentSelectors = [
                // Seletores mais específicos para comentários do Instagram
                'article div[role="button"] span',
                'div[data-testid="comment"] span',
                'article span[dir="auto"]',
                // Novos seletores para comentários
                'ul li article div span',
                'ul li div span[dir="auto"]',
                'section > div > div span',
                'div[style*="line-height"] span',
                // Seletores para comentários em threads
                'li[role="menuitem"] span',
                'div[aria-label*="Comment"] span',
                // Seletores alternativos
                'div[data-testid="Caption"] ~ div span',
                'article div:not([data-testid="Caption"]) span[dir="auto"]'
            ];
            
            const seenComments = new Set();
            
            // Função para verificar se é um comentário válido (AGORA com author disponível)
            const isValidComment = (text) => {
                const invalidTerms = [
                    'Curtir', 'Responder', 'Ver tradução', 'seguindo', 'followers', 
                    'Ver mais', 'Mostrar mais', 'ago', 'Seguir', 'curtidas',
                    'Curtiu por', 'e outras', 'pessoas curtiram', 'Ver todas',
                    'comentários', 'Adicionar comentário', 'Publicar', 'Curtido por',
                    'Visualizar perfil', 'há', 'min', 'sem', 'dia', 'dias',
                    'Áudio original', 'Música original', 'Som original'
                ];
                
                // Verificar se contém termos inválidos
                const hasInvalidTerms = invalidTerms.some(term => 
                    text.toLowerCase().includes(term.toLowerCase())
                );
                
                // Verificar se é muito curto ou muito longo
                const isGoodLength = text.length > 3 && text.length < 500;
                
                // Verificar se não é apenas emojis ou números
                const hasText = /[a-zA-ZÀ-ÿ]/.test(text);
                
                // Verificar se não é o nome do autor da postagem
                const isNotAuthor = author ? !text.toLowerCase().includes(author.toLowerCase()) : true;
                
                return !hasInvalidTerms && isGoodLength && hasText && isNotAuthor;
            };

            // Usar uma abordagem mais ampla para encontrar comentários
            console.log('Buscando comentários...');

            // Primeiro, tentar seletores específicos
            for (const selector of commentSelectors) {
                const elements = document.querySelectorAll(selector);
                console.log(`Selector ${selector}: ${elements.length} elementos encontrados`);
                
                for (const element of elements) {
                    const text = element.textContent.trim();
                    
                    if (isValidComment(text) && !seenComments.has(text) && comments.length < 15) {
                        seenComments.add(text);
                        comments.push(text);
                        console.log(`Comentário encontrado: ${text.substring(0, 50)}...`);
                    }
                }
            }

            // Se ainda não encontrou comentários suficientes, usar uma busca mais ampla
            if (comments.length < 5) {
                console.log('Poucos comentários encontrados, fazendo busca ampla...');
                
                // Buscar todos os spans com texto
                const allSpans = document.querySelectorAll('span');
                
                for (const span of allSpans) {
                    const text = span.textContent.trim();
                    
                    // Verificar se o elemento pai não contém elementos de interface
                    const parentClasses = span.parentElement?.className || '';
                    const isUIElement = parentClasses.includes('button') || 
                                      parentClasses.includes('nav') || 
                                      parentClasses.includes('header');
                    
                    if (!isUIElement && isValidComment(text) && !seenComments.has(text) && comments.length < 15) {
                        seenComments.add(text);
                        comments.push(text);
                        console.log(`Comentário (busca ampla): ${text.substring(0, 50)}...`);
                    }
                }
            }

            // Tentar extrair comentários de uma forma alternativa usando estrutura de lista
            if (comments.length < 3) {
                console.log('Tentando extrair comentários de listas...');
                
                const listItems = document.querySelectorAll('ul li, ol li');
                
                for (const li of listItems) {
                    const textSpans = li.querySelectorAll('span[dir="auto"]');
                    
                    for (const span of textSpans) {
                        const text = span.textContent.trim();
                        
                        if (isValidComment(text) && !seenComments.has(text) && comments.length < 15) {
                            seenComments.add(text);
                            comments.push(text);
                            console.log(`Comentário de lista: ${text.substring(0, 50)}...`);
                        }
                    }
                }
            }

            console.log(`Total de comentários extraídos: ${comments.length}`);
            
            // Log de debug para comentários
            console.log('Comentários extraídos:', comments);
            console.log('Número total de comentários:', comments.length);

            // Se não encontrou comentários, tentar uma estratégia diferente
            if (comments.length === 0) {
                console.log('Nenhum comentário encontrado. Tentando estratégia alternativa...');
                
                try {
                    // Esperar um pouco mais para os comentários carregarem
                    console.log('Aguardando carregamento de comentários...');
                    
                    // Tentar clicar no botão "Ver mais comentários" se existir
                    const moreCommentsButton = document.querySelector('button[aria-label*="comentários"], button[aria-label*="comments"]');
                    if (moreCommentsButton) {
                        console.log('Encontrado botão "Ver mais comentários"');
                        moreCommentsButton.click();
                        console.log('Botão clicado');
                    }
                    
                    // Rolar a página para baixo para carregar mais comentários
                    console.log('Rolando página para carregar comentários...');
                    window.scrollTo(0, document.body.scrollHeight);
                    
                    // Tentar extrair comentários novamente
                    const retryElements = document.querySelectorAll('span[dir="auto"]');
                    for (const element of retryElements) {
                        const text = element.textContent.trim();
                        if (isValidComment(text) && !seenComments.has(text) && comments.length < 10) {
                            seenComments.add(text);
                            comments.push(text);
                        }
                    }
                    
                    console.log(`Comentários após retry: ${comments.length}`);
                } catch (e) {
                    console.error('Erro ao tentar estratégia alternativa:', e.message);
                }
            }
            
            console.log('Dados extraídos:', {
                postTextLength: postText.length,
                commentsCount: comments.length,
                author: author
            });
            
            return {
                postText: postText || '',
                comments: comments,
                author: author || '',
                url: window.location.href,
                pageTitle: document.title || ''
            };
        });
        
        await browser.close();
        
        // Verificar se conseguiu extrair pelo menos algum conteúdo significativo
        if (!instagramData.postText && 
            instagramData.comments.length === 0 && 
            (!includeVideoTranscription || !videoInfo)) {
            
            console.log('Tentando estratégia alternativa de extração...');
            
            // Tentar uma segunda extração com seletores mais amplos
            const browser2 = await puppeteer.launch({ 
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const page2 = await browser2.newPage();
            await page2.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            
            try {
                await page2.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                const fallbackData = await page2.evaluate(() => {
                    // Busca mais ampla por qualquer texto relevante
                    const allText = document.body.innerText || '';
                    const title = document.title || '';
                    
                    // Extrair qualquer texto que pareça ser conteúdo da postagem
                    const lines = allText.split('\n').filter(line => 
                        line.trim().length > 20 && 
                        !line.includes('Instagram') &&
                        !line.includes('Seguir') &&
                        !line.includes('Curtir')
                    );
                    
                    return {
                        postText: lines.length > 0 ? lines[0] : '',
                        pageTitle: title,
                        allText: allText.substring(0, 500)
                    };
                });
                
                if (fallbackData.postText) {
                    instagramData.postText = fallbackData.postText;
                }
                
            } catch (fallbackError) {
                console.log('Estratégia alternativa também falhou:', fallbackError.message);
            } finally {
                await browser2.close();
            }
        }
        
        console.log('Dados extraídos do Instagram:', {
            postTextLength: instagramData.postText.length,
            commentsCount: instagramData.comments.length,
            author: instagramData.author
        });
        
        // Formatear o conteúdo extraído
        let content = '';
        
        if (instagramData.author) {
            content += `👤 Autor: ${instagramData.author}\n\n`;
        }
        
        if (instagramData.postText) {
            content += `📝 Postagem:\n${instagramData.postText}\n\n`;
        } else {
            content += `📝 Postagem:\n[Texto da postagem não foi possível extrair - pode ser apenas imagem/vídeo]\n\n`;
        }
        
        if (instagramData.comments.length > 0) {
            content += `💬 Comentários (${instagramData.comments.length}):\n`;
            instagramData.comments.forEach((comment, index) => {
                // Limitar o tamanho de cada comentário para não ficar muito longo
                const truncatedComment = comment.length > 200 ? comment.substring(0, 200) + '...' : comment;
                content += `${index + 1}. ${truncatedComment}\n`;
            });
            content += '\n';
        } else {
            content += `💬 Comentários: Nenhum comentário foi encontrado. A postagem pode ter comentários desabilitados ou não ter comentários ainda.\n\n`;
        }
        
        // Se for vídeo E includeVideoTranscription for true, processar e extrair informações
        let videoInfo = null;
        if (includeVideoTranscription && isVideo.isVideoContent) {
            try {
                console.log('Detectado conteúdo de vídeo, iniciando processamento...');
                sendProgressEvent('video_processing_start', 'Processando vídeo do Instagram...');
                
                // Adicionar timeout de 15 minutos para processamento de vídeo
                const videoResult = await Promise.race([
                    downloadAndProcessInstagramVideo(url),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout no processamento de vídeo')), 900000) // Aumentado para 15 minutos
                    )
                ]);
                videoInfo = videoResult;
                
                // Adicionar informações do vídeo ao conteúdo
                content += `🎬 Informações do vídeo:\n`;
                content += `• Duração: ${videoResult.videoInfo.duration} segundos\n`;
                content += `• Resolução: ${videoResult.videoInfo.width}x${videoResult.videoInfo.height}\n`;
                content += `• Tamanho: ${videoResult.videoInfo.size}\n`;
                
                if (videoResult.audioInfo.hasAudio) {
                    content += `• Áudio: ${videoResult.audioInfo.codec}, ${videoResult.audioInfo.channels} canais, ${videoResult.audioInfo.sampleRate}\n`;
                } else {
                    content += `• Áudio: Não detectado ou sem áudio\n`;
                }
                
                // Adicionar transcrição se disponível
                if (videoResult.transcription && videoResult.transcription.trim()) {
                    content += `\n🎙️ TRANSCRIÇÃO DO ÁUDIO:\n`;
                    content += `"${videoResult.transcription}"\n`;
                    console.log('Transcrição adicionada ao conteúdo:', videoResult.transcription.substring(0, 100));
                } else {
                    content += `\n🎙️ Transcrição: Não foi possível transcrever o áudio ou áudio não contém fala clara.\n`;
                    console.log('Transcrição não disponível ou vazia');
                }
                
                content += `\n`;
                
            } catch (videoError) {
                console.error('Erro no processamento do vídeo:', videoError.message);
                
                if (videoError.message.includes('Timeout')) {
                    content += `🎬 Vídeo detectado, mas o processamento demorou muito (timeout). Isso pode acontecer com vídeos longos ou conexão lenta.\n\n`;
                    sendProgressEvent('video_timeout', 'Timeout no processamento de vídeo');
                } else {
                content += `🎬 Vídeo detectado, mas não foi possível processar: ${videoError.message}\n\n`;
                    sendProgressEvent('video_error', `Erro no vídeo: ${videoError.message}`);
                }
            }
        } else if (includeVideoTranscription && isVideo.isVideoContent) {
            content += `🎬 Vídeo detectado (processamento não solicitado)\n\n`;
        } else if (!includeVideoTranscription && isVideo.isVideoContent) {
            content += `🎬 Vídeo detectado (transcrição desabilitada - apenas texto e comentários extraídos)\n\n`;
        }
        
        // Adicionar informações sobre limitações
        content += `ℹ️ Nota: Extração limitada a conteúdo público${isVideo.isVideoContent ? ' e processamento de vídeo pode demorar' : ''}.`;
        
        // Verificar se conseguiu extrair conteúdo significativo
        let hasSignificantContent = instagramData.postText || instagramData.comments.length > 0;
        // Se solicitou transcrição de vídeo, verificar se tem videoInfo
        if (includeVideoTranscription && !hasSignificantContent) {
            hasSignificantContent = !!videoInfo;
        }
        
        if (!hasSignificantContent) {
            throw new Error('Não foi possível extrair conteúdo significativo da postagem do Instagram. Verifique se a postagem é pública.');
        }
        
        // Se tem vídeo, processar
        let videoProcessingResult = null;
        let transcriptionFile = null;
        if (isVideo.hasVideo && includeVideoTranscription) {
            console.log('Detectado conteúdo de vídeo, iniciando processamento...');
            videoProcessingResult = await downloadAndProcessInstagramVideo(url);
            
            if (videoProcessingResult.transcription && 
                videoProcessingResult.transcription !== '[Áudio curto detectado - provavelmente contém fala]' &&
                videoProcessingResult.transcription !== '[Áudio de boa qualidade detectado - provável conteúdo falado]' &&
                !videoProcessingResult.transcription.startsWith('[')) {
                
                transcriptionFile = await saveTranscription(videoProcessingResult.transcription, videoId);
            }
        }
        
        // Montar resultado final
        const result = {
            type: 'instagram_post',
            title: `Post do Instagram - ${instagramData.author} (${isVideo.hasVideo ? 'Vídeo' : 'Imagem'})`,
            url: url,
            author: instagramData.author,
            postText: instagramData.postText,
            comments: instagramData.comments,
            commentsCount: instagramData.comments.length,
            hasVideo: includeVideoTranscription ? isVideo.hasVideo : false,
            videoInfo: videoProcessingResult?.videoInfo || null,
            audioInfo: videoProcessingResult?.audioInfo || null,
            transcription: videoProcessingResult?.transcription || null,
            transcriptionFile: transcriptionFile,
            wordCount: (instagramData.postText + ' ' + instagramData.comments.join(' ')).split(/\s+/).length
        };
        
        return result;
        
    } catch (error) {
        console.error('Erro na extração do Instagram:', error);
        throw error;
    }
}

// Função para extrair texto de artigo
async function extractArticleText(url, includeVideoTranscription = true) {
    try {
        console.log(`Tentando extrair conteúdo de: ${url}`);
        
        // Validar URL
        if (!url.match(/^https?:\/\//i)) {
            url = 'https://' + url;
            console.log(`URL corrigida para: ${url}`);
        }
        
        // Verificar se é URL do Instagram
        if (isInstagramUrl(url)) {
            console.log('Detectada URL do Instagram, usando extração específica...');
            const instagramMessage = includeVideoTranscription ? 
                'URL do Instagram detectada, processando texto e vídeo...' : 
                'URL do Instagram detectada, processando apenas texto e comentários...';
            sendProgressEvent('instagram_detected', instagramMessage);
            
            // Extrair conteúdo do Instagram
            const instagramResult = await extractInstagramContent(url, includeVideoTranscription);
            
            // Formatar o conteúdo para retorno padronizado
            let formattedContent = '';
            
            if (instagramResult.author) {
                formattedContent += `👤 Autor: ${instagramResult.author}\n\n`;
            }
            
            if (instagramResult.postText) {
                formattedContent += `📝 Postagem:\n${instagramResult.postText}\n\n`;
            } else {
                formattedContent += `📝 Postagem:\n[Texto da postagem não foi possível extrair - pode ser apenas imagem/vídeo]\n\n`;
            }
            
            if (instagramResult.comments && instagramResult.comments.length > 0) {
                formattedContent += `💬 Comentários (${instagramResult.comments.length}):\n`;
                instagramResult.comments.forEach((comment, index) => {
                    // Limitar o tamanho de cada comentário para não ficar muito longo
                    const truncatedComment = comment.length > 200 ? comment.substring(0, 200) + '...' : comment;
                    formattedContent += `${index + 1}. ${truncatedComment}\n`;
                });
                formattedContent += '\n';
            } else {
                formattedContent += `💬 Comentários: Nenhum comentário foi encontrado.\n\n`;
            }
            
            // Adicionar informações sobre vídeo se disponível
            if (instagramResult.hasVideo && instagramResult.transcription) {
                formattedContent += `🎬 TRANSCRIÇÃO DO VÍDEO:\n"${instagramResult.transcription}"\n\n`;
            } else if (instagramResult.hasVideo) {
                formattedContent += `🎬 Vídeo detectado (transcrição desabilitada)\n\n`;
            }
            
            return {
                title: instagramResult.title || `Post do Instagram - ${instagramResult.author}`,
                content: formattedContent,
                wordCount: instagramResult.wordCount || formattedContent.split(/\s+/).length,
                platform: 'Instagram',
                url: url
            };
        }
        
        // Configurar headers para evitar bloqueios
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        };
        
        // Tentar obter o conteúdo com timeout
        const response = await axios.get(url, {
            headers: headers,
            timeout: 15000 // 15 segundos de timeout
        });
        
        if (!response.data) {
            console.error('Resposta vazia da URL:', url);
            throw new Error('A URL não retornou conteúdo válido');
        }
        
        const $ = cheerio.load(response.data);
        
        // Remove elementos desnecessários
        $('script, style, nav, footer, header, aside, .sidebar, .advertisement, .ads, .cookie-banner, .popup').remove();
        
        // Tenta encontrar o conteúdo principal
        let content = '';
        const selectors = [
            'article',
            '.content',
            '.post-content',
            '.entry-content',
            '.article-content',
            'main',
            '.main-content',
            '.post',
            '.article',
            '.news-content',
            '.page-content',
            '#content',
            '.content-area'
        ];
        
        for (const selector of selectors) {
            const element = $(selector);
            if (element.length && element.text().trim().length > content.length) {
                content = element.text().trim();
            }
        }
        
        // Se não encontrou com seletores específicos, pega o texto do body
        if (!content || content.length < 100) {
            content = $('body').text().trim();
            
            // Limpar o conteúdo de caracteres não desejados e espaços extras
            content = content.replace(/\s+/g, ' ');
        }
        
        // Obter título
        const title = $('h1').first().text().trim() || 
                     $('title').text().trim() || 
                     new URL(url).hostname;
        
        // Verificar se conseguimos conteúdo significativo
        if (!content || content.length < 50) {
            console.error('Conteúdo insuficiente extraído de:', url);
            throw new Error('Não foi possível extrair conteúdo significativo desta página');
        }
        
        const result = {
            title: title,
            content: content,
            wordCount: content.split(/\s+/).length
        };
        
        console.log(`Extração bem-sucedida: ${url} (${result.wordCount} palavras)`);
        return result;
    } catch (error) {
        console.error('Erro ao extrair texto:', error.message);
        
        // Mensagens de erro mais específicas
        if (error.code === 'ENOTFOUND') {
            throw new Error('URL não encontrada. Verifique se o endereço está correto.');
        } else if (error.code === 'ECONNREFUSED') {
            throw new Error('Conexão recusada pelo servidor. O site pode estar bloqueando acessos automatizados.');
        } else if (error.response && error.response.status === 403) {
            throw new Error('Acesso proibido (403). O site está bloqueando nossa requisição.');
        } else if (error.response && error.response.status === 404) {
            throw new Error('Página não encontrada (404). Verifique se a URL está correta.');
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
            throw new Error('Tempo limite excedido. O site demorou muito para responder.');
        }
        
        throw new Error(`Erro ao extrair conteúdo do artigo: ${error.message}`);
    }
}

// Função para verificar notícias diretamente em sites confiáveis
async function verifyNewsInTrustedSites(keyword) {
    console.log(`Verificando notícias sobre "${keyword}" em sites confiáveis...`);
    
    // Lista de sites de notícias confiáveis brasileiros
    const trustedSites = [
        { url: 'https://g1.globo.com/busca/', searchParam: 'q' },
        { url: 'https://www.uol.com.br/busca/', searchParam: 'q' },
        { url: 'https://www.terra.com.br/busca/', searchParam: 'query' },
        { url: 'https://www.cnnbrasil.com.br/busca/', searchParam: 'q' },
        { url: 'https://www.estadao.com.br/busca/', searchParam: 'termo' },
        { url: 'https://www.folha.uol.com.br/busca/', searchParam: 'q' },
        { url: 'https://www.r7.com/busca/', searchParam: 'q' },
        { url: 'https://www.fuxicogospel.com.br/', searchParam: 's' }
    ];
    
    // Extrair palavras-chave principais para verificar relevância
    const keywordLower = keyword.toLowerCase();
    const keywordParts = keywordLower.split(' ').filter(part => part.length > 3);
    
    // Resultados encontrados
    const results = [];
    let isVerified = false;
    let isFalseEvent = false;
    
    // Detectar se é uma notícia sobre morte/falecimento
    const isDeathNews = keywordLower.includes('morte') || 
                        keywordLower.includes('falecimento') ||
                        keywordLower.includes('faleceu') ||
                        keywordLower.includes('morreu');
                        
    // Extrair nome da pessoa em caso de notícias de morte
    let personName = '';
    if (isDeathNews) {
        personName = keywordLower
            .replace('morte de ', '')
            .replace('falecimento de ', '')
            .replace('morte do ', '')
            .replace('falecimento do ', '')
            .replace('morte da ', '')
            .replace('falecimento da ', '')
            .trim();
            
        console.log(`Verificando notícia sobre possível morte de: "${personName}"`);
    }
    
    // Verificar em cada site confiável
    for (const site of trustedSites) {
        try {
            const searchUrl = `${site.url}?${site.searchParam}=${encodeURIComponent(keyword)}`;
            console.log(`Consultando: ${searchUrl}`);
            
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml',
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
                },
                timeout: 10000
            });
            
            if (response.status === 200) {
                const html = response.data;
                const $ = cheerio.load(html);
                
                // Buscar resultados de pesquisa (links, títulos, etc.)
                const searchResults = [];
                
                // Diferentes seletores para diferentes sites
                const selectors = [
                    'a.widget--info__title', // G1
                    'a.thumbnail__title', // UOL
                    'a.card__title', // Terra
                    'a.news-item-header__title', // CNN
                    'a.link-title', // Estadão
                    'a.c-headline__title', // Folha
                    'a.r7-search-result-link' // R7
                ];
                
                // Função para verificar se um texto é relevante para a pesquisa
                const isRelevantResult = (text) => {
                    text = text.toLowerCase();
                    
                    // Para notícias de morte, verificar se menciona a pessoa
                    if (isDeathNews && personName) {
                        // Verificar se o nome da pessoa está mencionado
                        const nameParts = personName.split(' ');
                        let nameMatches = 0;
                        
                        // Verificar quantas partes do nome são mencionadas
                        for (const part of nameParts) {
                            if (part.length > 3 && text.includes(part)) {
                                nameMatches++;
                            }
                        }
                        
                        // Se menciona pelo menos duas partes do nome (ou uma se for nome único)
                        const hasNameMention = nameMatches >= Math.min(2, nameParts.length);
                        
                        // Verificar se menciona morte/falecimento junto com o nome
                        return hasNameMention && 
                               (text.includes('morte') || 
                                text.includes('faleceu') || 
                                text.includes('falecimento') ||
                                text.includes('morreu') ||
                                text.includes('óbito'));
                    }
                    
                    // Para outros tipos de notícia, verificar se contém palavras-chave principais
                    let relevanceScore = 0;
                    for (const part of keywordParts) {
                        if (text.includes(part)) {
                            relevanceScore++;
                        }
                    }
                    
                    // Considerar relevante se contiver pelo menos metade das palavras-chave
                    return relevanceScore >= Math.ceil(keywordParts.length / 2);
                };
                
                // Buscar por qualquer link que contenha o texto da pesquisa
                $('a').each((i, el) => {
                    const linkText = $(el).text().trim();
                    const href = $(el).attr('href');
                    
                    if (linkText && href && linkText.length > 15) {
                        // Verificar se o resultado é relevante para a pesquisa
                        if (isRelevantResult(linkText)) {
                            searchResults.push({
                                title: linkText,
                                url: href.startsWith('http') ? href : `https://${new URL(site.url).hostname}${href}`,
                                source: new URL(site.url).hostname
                            });
                        }
                    }
                });
                
                // Buscar por seletores específicos
                selectors.forEach(selector => {
                    $(selector).each((i, el) => {
                        const linkText = $(el).text().trim();
                        const href = $(el).attr('href');
                        
                        if (linkText && href && isRelevantResult(linkText)) {
                            searchResults.push({
                                title: linkText,
                                url: href.startsWith('http') ? href : `https://${new URL(site.url).hostname}${href}`,
                                source: new URL(site.url).hostname
                            });
                        }
                    });
                });
                
                // Se encontrou resultados relevantes, considerar verificado
                if (searchResults.length > 0) {
                    isVerified = true;
                    results.push(...searchResults.slice(0, 3)); // Limitar a 3 resultados por site
                    
                    // Para notícias de morte, verificar se há indicações de fake news
                    if (isDeathNews && personName) {
                        const pageText = $('body').text().toLowerCase();
                        
                        // Verificar se há termos que indicam fake news
                        const fakeNewsIndicators = [
                            'fake news', 'notícia falsa', 'boato', 'desmentiu',
                            'não morreu', 'está vivo', 'desmente', 'rumor falso'
                        ];
                        
                        for (const indicator of fakeNewsIndicators) {
                            if (pageText.includes(indicator) && 
                                pageText.includes(personName.toLowerCase())) {
                                console.log(`Possível fake news detectada: "${indicator}" encontrado junto com "${personName}"`);
                                isFalseEvent = true;
                                break;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Erro ao consultar ${site.url}:`, error.message);
        }
    }
    
    // Se for uma notícia de morte, fazer uma verificação adicional
    if (isDeathNews && personName && !isFalseEvent) {
        try {
            // Pesquisar especificamente por "[nome] está vivo"
            const aliveCheckUrl = `https://www.google.com/search?q=${encodeURIComponent(personName + " está vivo")}`;
            
            const response = await axios.get(aliveCheckUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
                },
                timeout: 10000
            });
            
            if (response.status === 200) {
                const html = response.data;
                const $ = cheerio.load(html);
                const pageText = $('body').text().toLowerCase();
                
                // Verificar se há indicações de que a pessoa está viva
                const aliveIndicators = [
                    'está vivo', 'não morreu', 'desmentiu', 'fake news',
                    'notícia falsa', 'boato', 'continua vivo', 'desmente boato'
                ];
                
                for (const indicator of aliveIndicators) {
                    if (pageText.includes(indicator) && pageText.includes(personName.toLowerCase())) {
                        console.log(`Indicação de que ${personName} está vivo: "${indicator}" encontrado`);
                        isFalseEvent = true;
                        break;
                    }
                }
            }
        } catch (error) {
            console.error('Erro na verificação adicional:', error.message);
        }
    }
    
    // Verificação adicional para notícias de morte - buscar diretamente no Google
    if (isDeathNews && personName && !isFalseEvent && results.length === 0) {
        try {
            // Buscar especificamente por "morte [nome]" no Google
            const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent("morte " + personName)}`;
            
            const response = await axios.get(googleSearchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
                },
                timeout: 10000
            });
            
            if (response.status === 200) {
                const html = response.data;
                const $ = cheerio.load(html);
                
                // Extrair resultados de pesquisa do Google
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && href.startsWith('/url?q=')) {
                        const url = href.replace('/url?q=', '').split('&')[0];
                        const $parent = $(el).closest('div');
                        let title = '';
                        
                        // Tentar extrair o título de várias maneiras
                        const h3 = $parent.find('h3').first();
                        if (h3.length) {
                            title = h3.text().trim();
                        } else {
                            title = $(el).text().trim();
                        }
                        
                        if (title && url && !url.includes('google.com') && title.length > 15) {
                            // Verificar relevância
                            if (isRelevantResult(title)) {
                                results.push({
                                    title: title,
                                    url: url,
                                    source: new URL(url).hostname
                                });
                                isVerified = true;
                            }
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Erro na busca adicional no Google:', error.message);
        }
    }
    
    return { 
        isVerified, 
        isFalseEvent, 
        results: results.slice(0, 10) // Limitar a 10 resultados no total
    };
}

// Função para extrair conteúdo de uma URL
async function extractContentFromUrl(url, keyword) {
    try {
        // Corrigir URLs do G1 que têm formato incorreto
        if (url.includes('//g1.globo.com/busca/click')) {
            // Extrair a URL real do parâmetro 'u'
            const match = url.match(/u=(https?%3A%2F%2F[^&]+)/);
            if (match) {
                url = decodeURIComponent(match[1]);
                console.log(`URL do G1 corrigida para: ${url}`);
            }
        }
        
        console.log(`Extraindo conteúdo de: ${url}`);
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 15000
        });
        
        if (response.status === 200) {
            const html = response.data;
            const $ = cheerio.load(html);
            
            // Remover elementos desnecessários
            $('script, style, nav, footer, header, aside, .sidebar, .advertisement, .ads').remove();
            
            // Obter o título da página
            const title = $('h1').first().text().trim() || $('title').text().trim();
            
            // Tentar encontrar o conteúdo principal
            const selectors = [
                'article', '.article', '.post', '.content', '.entry-content',
                '.post-content', 'main', '.main-content', '.news-content',
                '.materia-content', '.corpo', '.texto', '.noticia', '.article__content',
                '.content-text', '#content', '.content-body'
            ];
            
            let content = '';
            for (const selector of selectors) {
                const element = $(selector);
                if (element.length) {
                    const text = element.text().trim();
                    if (text.length > content.length) {
                        content = text;
                    }
                }
            }
            
            // Se não encontrou com seletores específicos, pegar o texto do body
            if (!content || content.length < 200) {
                content = $('body').text().trim();
            }
            
            // Verificar se o conteúdo é relevante para a keyword
            const keywordLower = keyword.toLowerCase();
            const contentLower = content.toLowerCase();
            const titleLower = title.toLowerCase();
            
            // Extrair palavras-chave principais
            const keywordParts = keywordLower.split(' ').filter(part => part.length > 3);
            
            // Verificar relevância
            let relevanceScore = 0;
            for (const part of keywordParts) {
                if (contentLower.includes(part) || titleLower.includes(part)) {
                    relevanceScore++;
                }
            }
            
            // Se o conteúdo não for relevante o suficiente, retornar null
            const isRelevant = relevanceScore >= Math.ceil(keywordParts.length / 2);
            if (!isRelevant) {
                console.log(`Conteúdo de ${url} não é relevante para "${keyword}"`);
                return null;
            }
            
            return {
                title,
                content: content.substring(0, 2000), // Limitar tamanho
                url
            };
        }
    } catch (error) {
        console.error(`Erro ao extrair conteúdo de ${url}:`, error.message);
        return null;
    }
    
    return null;
}

// Função para pesquisar notícias
async function searchNews(keyword, options = {}) {
    const { limit = 5, useGoogle = true, useGnews = false } = options;
    let articles = [];
    
    // Enviar evento de progresso: iniciando pesquisa
    sendProgressEvent('search_start', 'Pesquisando em sites confiáveis...');
    
    // Verificar se o evento é real usando sites confiáveis
    const verificationResult = await verifyNewsInTrustedSites(keyword);
    
    // Enviar evento de progresso: verificação concluída
    sendProgressEvent('verification_complete', 'Verificando informações...');
    
    // Se for um evento falso (como morte de alguém que está vivo), retornar erro
    if (verificationResult.isFalseEvent) {
        sendProgressEvent('verification_failed', 'Informação não verificada!');
        throw new Error(`Não foi possível verificar a veracidade do evento "${keyword}". Parece ser uma informação falsa ou boato.`);
    }
    
    // Se encontrou resultados em sites confiáveis, usar esses resultados
    if (verificationResult.results.length > 0) {
        console.log(`Encontrados ${verificationResult.results.length} resultados em sites confiáveis`);
        
        // Extrair conteúdo das páginas encontradas
        sendProgressEvent('extraction_start', 'Extraindo conteúdo relevante...');
        const extractedContents = [];
        
        for (const result of verificationResult.results) {
            try {
                sendProgressEvent('extracting_url', `Extraindo conteúdo de: ${result.url}`);
                const content = await extractContentFromUrl(result.url, keyword);
                if (content) {
                    extractedContents.push({
                        title: content.title || result.title,
                        description: content.content.substring(0, 200) + '...',
                        content: content.content,
                        url: content.url,
                        publishedAt: new Date().toISOString(),
                        source: { name: result.source }
                    });
                }
            } catch (error) {
                console.error(`Erro ao processar ${result.url}:`, error.message);
            }
        }
        
        sendProgressEvent('extraction_complete', 'Conteúdo extraído com sucesso!');
        
        // Se conseguiu extrair conteúdo relevante
        if (extractedContents.length > 0) {
            articles = extractedContents;
        } else {
            // Se não conseguiu extrair conteúdo, usar apenas os metadados
            articles = verificationResult.results.map(result => ({
                title: result.title,
                description: '',
                url: result.url,
                publishedAt: new Date().toISOString(),
                source: { name: result.source }
            }));
        }
    } else if (useGoogle) {
        // Se não encontrou em sites confiáveis, tentar com Google
        try {
            sendProgressEvent('google_search', 'Tentando pesquisa no Google...');
            console.log('Tentando pesquisa no Google...');
            // Usar axios para pesquisar no Google
            const response = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(keyword)}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
                }
            });
            
            if (response.status === 200) {
                const $ = cheerio.load(response.data);
                const results = [];
                
                // Extrair resultados de pesquisa
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && href.startsWith('/url?q=')) {
                        const url = href.replace('/url?q=', '').split('&')[0];
                        const title = $(el).find('h3').text().trim();
                        
                        if (title && url && !url.includes('google.com')) {
                            results.push({
                                title,
                                url,
                                source: new URL(url).hostname
                            });
                        }
                    }
                });
                
                // Extrair conteúdo dos resultados
                const extractedContents = [];
                
                for (const result of results.slice(0, 5)) {
                    try {
                        const content = await extractContentFromUrl(result.url, keyword);
                        if (content) {
                            extractedContents.push({
                                title: content.title || result.title,
                                description: content.content.substring(0, 200) + '...',
                                content: content.content,
                                url: content.url,
                                publishedAt: new Date().toISOString(),
                                source: { name: result.source }
                            });
                        }
                    } catch (error) {
                        console.error(`Erro ao processar ${result.url}:`, error.message);
                    }
                }
                
                // Adicionar aos artigos
                if (extractedContents.length > 0) {
                    articles = [...articles, ...extractedContents];
                } else if (results.length > 0) {
                    articles = [...articles, ...results.map(result => ({
                        title: result.title,
                        description: '',
                        url: result.url,
                        publishedAt: new Date().toISOString(),
                        source: { name: result.source }
                    }))];
                }
            }
        } catch (error) {
            console.error('Erro na pesquisa do Google:', error.message);
        }
    }
    
    // Tentar APIs de notícias se habilitado ou se não tiver resultados
    if (useGnews || articles.length === 0) {
        try {
            sendProgressEvent('news_api_attempt', 'Tentando News API...');
            console.log('Tentando News API...');
            // Tentativa com News API
            const newsApiResponse = await axios.get(`https://newsapi.org/v2/everything`, {
                params: {
                    q: keyword,
                    apiKey: NEWS_API_KEY,
                    language: 'pt',
                    sortBy: 'relevancy',
                    pageSize: limit
                }
            });
            const newsApiArticles = newsApiResponse.data.articles;
            
            if (newsApiArticles && newsApiArticles.length > 0) {
                articles = [...articles, ...newsApiArticles];
            }
        } catch (newsApiError) {
            sendProgressEvent('news_api_failed', 'News API falhou, tentando GNews...');
            console.log('News API falhou, tentando GNews...');
            
            // Fallback para GNews API
            try {
                const gnewsResponse = await axios.get(`https://gnews.io/api/v4/search`, {
                    params: {
                        q: keyword,
                        token: GNEWS_API_KEY,
                        lang: 'pt',
                        max: limit
                    }
                });
                const gnewsArticles = gnewsResponse.data.articles;
                
                if (gnewsArticles && gnewsArticles.length > 0) {
                    articles = [...articles, ...gnewsArticles];
                }
            } catch (gnewsError) {
                sendProgressEvent('gnews_failed', 'GNews também falhou');
                console.log('GNews também falhou');
            }
        }
    }
    
    // Se não encontrou resultados e não conseguiu verificar, informar ao usuário
    if (articles.length === 0) {
        // Verificar se é uma palavra-chave potencialmente problemática
        const sensitiveKeywords = ['morte', 'falecimento', 'faleceu', 'morreu', 'assassinato', 'acidente fatal'];
        const isSensitiveTopic = sensitiveKeywords.some(word => keyword.toLowerCase().includes(word));
        
        if (isSensitiveTopic && !verificationResult.isVerified) {
            sendProgressEvent('verification_failed', 'Não foi possível encontrar informações verificáveis sobre este tema.');
            throw new Error(`Não foi possível encontrar informações verificáveis sobre "${keyword}". Este pode ser um evento que não ocorreu ou uma notícia falsa. Por favor, verifique outras fontes.`);
        }
        
        if (!verificationResult.isVerified) {
            sendProgressEvent('verification_failed', 'Não foi possível encontrar informações verificáveis sobre este tema.');
            throw new Error(`Não foi possível encontrar informações verificáveis sobre "${keyword}". Por favor, tente outro tema ou verifique se o evento realmente aconteceu.`);
        }
        
        // Usar dados genéricos apenas se o evento for verificado
        sendProgressEvent('using_generic_data', 'Usando dados genéricos...');
        console.log('Usando dados genéricos...');
        articles = [
            {
                title: `Informações sobre ${keyword}`,
                description: `Não foram encontradas notícias específicas sobre "${keyword}", mas o tema parece ser válido.`,
                url: '#',
                publishedAt: new Date().toISOString(),
                source: { name: 'Informação Genérica' }
            }
        ];
    }
    
    // Limitar o número de resultados e remover duplicatas
    const uniqueUrls = new Set();
    const uniqueArticles = [];
    
    for (const article of articles) {
        if (!uniqueUrls.has(article.url)) {
            uniqueUrls.add(article.url);
            uniqueArticles.push(article);
            
            if (uniqueArticles.length >= limit) {
                break;
            }
        }
    }
    
    sendProgressEvent('search_complete', 'Pesquisa concluída!');
    
    return uniqueArticles;
}

// Rotas da API

// Página inicial
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Análise de SEO
app.post('/api/analyze-seo', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL é obrigatória' });
        }
        
        const seoData = await analyzeSEO(url);
        
        // Gera sugestões de melhoria com IA
        const prompt = `Analise os dados SEO a seguir e forneça sugestões específicas de melhoria:

DADOS SEO:
- Título: ${seoData.title}
- Meta Description: ${seoData.metaDescription}
- H1 Tags: ${seoData.h1Tags.join(', ')}
- H2 Tags: ${seoData.h2Tags.slice(0, 5).join(', ')}
- Número de imagens sem alt: ${seoData.images.filter(img => img.alt === 'Sem alt text').length}
- Links internos: ${seoData.internalLinks}
- Links externos: ${seoData.externalLinks}
- Tamanho do conteúdo: ${seoData.textContent} caracteres

Forneça sugestões práticas e específicas para melhorar o SEO em português brasileiro.`;

        const suggestions = await callTogetherAPI(prompt);
        
        res.json({
            seoData,
            suggestions
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Extrair e reescrever texto
app.post('/api/rewrite-content', async (req, res) => {
    try {
        const { url, tone = 'profissional', observation = '' } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL é obrigatória' });
        }
        
        const article = await extractArticleText(url);
        
        const prompt = `Reescreva o seguinte texto de forma original, mantendo as informações principais mas com linguagem e estrutura completamente diferentes. Use um tom ${tone} e formato jornalístico brasileiro:

TÍTULO ORIGINAL: ${article.title}

CONTEÚDO ORIGINAL:
${article.content.substring(0, 2000)}

${observation ? `OBSERVAÇÃO DO USUÁRIO (foco da reescrita): ${observation}\n\n` : ''}

INSTRUÇÕES:
- Reescreva completamente sem copiar frases
- Mantenha os fatos e informações principais
- Use linguagem jornalística brasileira
- Não use hashtags ou símbolos # para títulos e subtítulos
${observation ? `- IMPORTANTE: Dê atenção especial à OBSERVAÇÃO DO USUÁRIO, priorizando esse foco na reescrita` : ''}
- Organize o conteúdo da seguinte forma:

TÍTULO: Um título atrativo e conciso
SUBTÍTULO: Um subtítulo que complementa o título e resume o conteúdo
TAGS: 5-7 tags relevantes separadas por vírgula
PALAVRA-CHAVE DE CAUDA LONGA: Uma frase de busca específica relacionada ao tema
CONTEÚDO: O texto principal bem estruturado em parágrafos
`;

        const rewrittenContent = await callTogetherAPI(prompt);
        
        res.json({
            original: {
                title: article.title,
                content: article.content.substring(0, 500) + '...',
                wordCount: article.wordCount
            },
            rewritten: rewrittenContent
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Pesquisar e criar matéria
app.post('/api/create-article', async (req, res) => {
    try {
        const { keyword, tone = 'jornalístico', length = 'médio', useGoogle = true, useGnews = false } = req.body;
        
        if (!keyword) {
            return res.status(400).json({ error: 'Palavra-chave é obrigatória' });
        }
        
        try {
            // Pesquisa notícias relacionadas
            const articles = await searchNews(keyword, { limit: 5, useGoogle, useGnews });
            
            // Prepara contexto para a IA
            let newsContext = '';
            
            if (articles.length > 0) {
                // Adicionar títulos e descrições
                newsContext += articles.map(article => 
                    `- ${article.title}: ${article.description || ''}`
                ).join('\n');
                
                // Adicionar conteúdo extraído se disponível
                const extractedContent = articles
                    .filter(article => article.content)
                    .map(article => `\nCONTEÚDO DE "${article.title}":\n${article.content?.substring(0, 1000)}...\n`);
                    
                if (extractedContent.length > 0) {
                    newsContext += '\n\nCONTEÚDO EXTRAÍDO:\n' + extractedContent.join('\n---\n');
                }
            }
            
            const lengthInstructions = {
                'curto': '300-500 palavras',
                'médio': '600-800 palavras',
                'longo': '1000-1500 palavras'
            };
            
            sendProgressEvent('generating_start', 'Gerando sua matéria...');
            
            const prompt = `Crie uma matéria jornalística original sobre "${keyword}" baseada nas seguintes informações e notícias recentes:

INFORMAÇÕES COLETADAS:
${newsContext || 'Não foi possível encontrar notícias específicas sobre este tema.'}

INSTRUÇÕES:
- Crie uma matéria completamente original (não copie das fontes)
- Use tom ${tone}
- Extensão: ${lengthInstructions[length]}
- Formato jornalístico brasileiro
- NÃO use hashtags ou símbolos # para títulos e subtítulos
- IMPORTANTE: Seja factual e preciso com as informações
- IMPORTANTE: NÃO INVENTE FATOS OU EVENTOS QUE NÃO ACONTECERAM
- IMPORTANTE: Se não houver informações suficientes, explique isso na matéria em vez de criar conteúdo fictício
- CRÍTICO: Baseie-se APENAS nas fontes fornecidas e não adicione informações que não estejam nelas
- CRÍTICO: Se as fontes não mencionarem detalhes sobre o evento principal, NÃO os invente
- CRÍTICO: Se as fontes fornecidas não forem sobre o tema específico, mencione isso claramente no início da matéria
- CRÍTICO: Se as fontes não contiverem informações suficientes sobre o tema, crie uma matéria mais genérica ou explicativa sobre o tema

ESTRUTURA INTERNA (para seu planejamento, mas não inclua esses rótulos no texto final):
- Título: Um título atrativo e conciso que reflita com precisão o conteúdo das fontes
- Subtítulo: Um subtítulo que complementa o título e resume o conteúdo factual
- Tags: 5-7 tags relevantes (para uso interno apenas)
- Palavra-chave de cauda longa: Uma frase de busca específica (para uso interno apenas)
- Conteúdo: O texto principal bem estruturado em parágrafos com subtítulos em negrito (sem usar #)

FORMATO DE SAÍDA:
Forneça APENAS o seguinte formato:

### [TÍTULO DA MATÉRIA]

[SUBTÍTULO DA MATÉRIA] 

[CONTEÚDO COMPLETO DA MATÉRIA]

Não inclua as palavras "TÍTULO:", "SUBTÍTULO:", "TAGS:", "PALAVRA-CHAVE DE CAUDA LONGA:" ou "CONTEÚDO:" no texto final. Apenas forneça o título formatado com ### no início, seguido pelo subtítulo em uma linha separada, e então o conteúdo completo.

A matéria deve ser informativa e baseada apenas em fatos verificáveis. Se não houver informações suficientes, explique isso claramente e forneça um contexto mais amplo sobre o tema em vez de inventar detalhes específicos.

Se as fontes fornecidas não forem diretamente relacionadas ao tema principal (${keyword}), comece a matéria com um aviso como: "NOTA: As fontes disponíveis não contêm informações específicas sobre [tema principal]. Esta matéria abordará o tema de forma mais ampla com base em informações gerais."`;

            const article = await callTogetherAPI(prompt);
            sendProgressEvent('generating_complete', 'Matéria gerada com sucesso!');
            
            // Extrair título, subtítulo e conteúdo do texto gerado
            sendProgressEvent('formatting_start', 'Formatando resultado...');
            let title = '';
            let subtitle = '';
            let content = '';
            let tags = '';
            let longTailKeyword = '';
            
            // Processar o texto para extrair as partes
            const lines = article.split('\n').filter(line => line.trim());
            
            // O título deve começar com ### 
            if (lines.length > 0 && lines[0].startsWith('###')) {
                title = lines[0].replace('###', '').trim();
                
                // O subtítulo deve ser a próxima linha não vazia
                if (lines.length > 1) {
                    subtitle = lines[1].trim();
                    
                    // O conteúdo é todo o resto
                    if (lines.length > 2) {
                        content = lines.slice(2).join('\n').trim();
                        
                        // Substituir marcadores de negrito (**Texto**) por tags H3
                        content = content.replace(/\*\*(.*?)\*\*/g, '<h3>$1</h3>');
                    }
                }
            } else {
                // Se não seguir o formato esperado, usar todo o texto como conteúdo
                content = article;
            }
            
            // Gerar tags e palavra-chave de cauda longa com base no conteúdo
            const tagsPrompt = `Com base no título "${title}" e no conteúdo a seguir, gere apenas 5-7 tags relevantes separadas por vírgula, sem explicações adicionais:
            
            ${subtitle}
            
            ${content.substring(0, 500)}`;
            
            const keywordPrompt = `Com base no título "${title}" e no conteúdo a seguir, gere apenas uma frase de busca específica (palavra-chave de cauda longa) relacionada ao tema, sem explicações adicionais:
            
            ${subtitle}
            
            ${content.substring(0, 500)}`;
            
            // Obter tags e palavra-chave em paralelo
            const [tagsResponse, keywordResponse] = await Promise.all([
                callTogetherAPI(tagsPrompt),
                callTogetherAPI(keywordPrompt)
            ]);
            
            tags = tagsResponse.trim();
            longTailKeyword = keywordResponse.trim();
            
            sendProgressEvent('formatting_complete', 'Formatação concluída!');
            sendProgressEvent('article_complete', 'Matéria pronta!');
            
            res.json({
                keyword,
                sources: articles.map(a => ({ 
                    title: a.title, 
                    url: a.url, 
                    source: a.source?.name || new URL(a.url).hostname
                })),
                article: {
                    title,
                    subtitle,
                    content,
                    tags,
                    longTailKeyword,
                    fullText: article
                }
            });
        } catch (searchError) {
            // Se houver erro na pesquisa (como evento falso), retornar mensagem específica
            return res.status(400).json({ 
                error: searchError.message,
                isFactualError: true
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Chat geral
app.post('/api/chat', async (req, res) => {
    try {
        const { message, originalMessage, extractedContents } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Mensagem é obrigatória' });
        }
        
        let prompt = message;
        let userMessage = originalMessage || message;
        
        // Se houver conteúdos extraídos, formatar o prompt para incluí-los
        if (extractedContents && extractedContents.length > 0) {
            // Verificar se o conteúdo já está incluído na mensagem
            if (message.includes("CONTEÚDO EXTRAÍDO DAS URLS:")) {
                // O conteúdo já está na mensagem, apenas adicionar instruções
                prompt = `${message}\n\n` + 
                        `INSTRUÇÕES PARA A IA:\n` +
                        `1. Você deve responder à pergunta do usuário "${userMessage}" com base no(s) conteúdo(s) extraído(s) acima.\n` +
                        `2. Seja específico e detalhado, citando informações relevantes do texto.\n` +
                        `3. Se a pergunta não puder ser respondida com o conteúdo fornecido, explique o que o conteúdo realmente aborda.\n` +
                        `4. Não invente informações que não estejam no texto.\n` +
                        `5. Formate sua resposta de maneira clara e organizada.`;
            } else {
                // Construir o prompt com todos os conteúdos extraídos
                let contentSection = "";
                
                extractedContents.forEach((content, index) => {
                    contentSection += `===== CONTEÚDO ${index + 1} =====\n`;
                    contentSection += `TÍTULO: ${content.title || 'Sem título'}\n`;
                    contentSection += `FONTE: ${content.url || 'URL não disponível'}\n\n`;
                    contentSection += `${content.content}\n\n`;
                });
                
                prompt = `Baseado nos seguintes conteúdos extraídos de URLs:

${contentSection}
===== FIM DOS CONTEÚDOS =====

Pergunta do usuário: ${userMessage}

INSTRUÇÕES:
1. Responda à pergunta do usuário com base APENAS nas informações contidas nos textos acima.
2. Seja específico e detalhado, citando informações relevantes dos textos.
3. Se a pergunta não puder ser respondida com os conteúdos fornecidos, explique o que os conteúdos realmente abordam.
4. Não invente informações que não estejam nos textos.
5. Formate sua resposta de maneira clara e organizada.`;
            }
        }
        
        console.log("Enviando prompt para a API:", prompt.substring(0, 200) + "...");
        const response = await callTogetherAPI(prompt);
        
        res.json({ response });
    } catch (error) {
        console.error('Erro no processamento do chat:', error);
        res.status(500).json({ error: error.message });
    }
});

// Extrair conteúdo de URL para chat
app.post('/api/extract-url-content', async (req, res) => {
    try {
        const { url, includeVideoTranscription = true } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL é obrigatória' });
        }
        
        sendProgressEvent('extraction_start', 'Extraindo conteúdo da URL...');
        console.log(`Iniciando extração de conteúdo de: ${url} (transcrição: ${includeVideoTranscription})`);
        
        try {
            // Validar formato da URL
            let validatedUrl = url;
            if (!validatedUrl.match(/^https?:\/\//i)) {
                validatedUrl = 'https://' + validatedUrl;
                console.log(`URL corrigida para: ${validatedUrl}`);
            }
            
            // Verificar se a URL é válida
            try {
                new URL(validatedUrl);
            } catch (urlError) {
                sendProgressEvent('extraction_failed', 'URL inválida');
                return res.status(400).json({ error: 'URL inválida. Por favor, forneça uma URL válida.' });
            }
            
            // Tentar extrair o conteúdo
            const content = await extractArticleText(validatedUrl, includeVideoTranscription);
            
            if (!content || !content.content) {
                sendProgressEvent('extraction_failed', 'Não foi possível extrair conteúdo da URL');
                return res.status(400).json({ 
                    error: 'Não foi possível extrair conteúdo desta URL. Verifique se o link é válido e acessível.'
                });
            }
            
            // Verificar se o conteúdo tem tamanho suficiente
            if (content.content.length < 100) {
                sendProgressEvent('extraction_failed', 'Conteúdo extraído muito pequeno');
                return res.status(400).json({ 
                    error: 'O conteúdo extraído é muito pequeno ou não significativo. Tente outra URL.'
                });
            }
            
            sendProgressEvent('extraction_complete', 'Conteúdo extraído com sucesso!');
            console.log(`Extração concluída com sucesso: ${validatedUrl} (${content.wordCount} palavras)`);
            
            res.json({
                title: content.title,
                content: content.content,
                wordCount: content.wordCount,
                platform: content.platform || null,
                url: validatedUrl
            });
        } catch (error) {
            console.error('Erro durante extração de conteúdo:', error);
            sendProgressEvent('extraction_failed', `Erro ao extrair conteúdo: ${error.message}`);
            
            // Determinar o tipo de erro para fornecer uma mensagem mais útil
            let errorMessage = error.message;
            let statusCode = 500;
            
            if (error.message.includes('URL não encontrada') || 
                error.message.includes('Página não encontrada')) {
                statusCode = 404;
            } else if (error.message.includes('Acesso proibido') || 
                       error.message.includes('bloqueando')) {
                statusCode = 403;
            } else if (error.message.includes('Tempo limite')) {
                errorMessage = 'Tempo limite excedido ao tentar acessar a URL. O site pode estar lento ou inacessível.';
            }
            
            return res.status(statusCode).json({ error: errorMessage });
        }
    } catch (error) {
        console.error('Erro geral na rota de extração:', error);
        res.status(500).json({ error: 'Erro interno do servidor ao processar a solicitação.' });
    }
});

// Salvar texto editado
app.post('/api/save-edited-text', async (req, res) => {
    try {
        const { originalText, editedText, context } = req.body;
        
        if (!editedText) {
            return res.status(400).json({ error: 'Texto editado é obrigatório' });
        }
        
        console.log('Recebida solicitação para salvar texto editado');
        
        // Aqui você poderia implementar lógica para salvar o texto em um banco de dados,
        // ou processar de alguma outra forma se necessário.
        // Por enquanto, apenas confirmamos que recebemos o texto editado.
        
        // Opcionalmente, você pode usar a IA para melhorar ou verificar o texto editado
        let enhancedText = editedText;
        
        if (req.body.enhance) {
            try {
                console.log('Aprimorando texto editado com IA');
                const prompt = `
O seguinte texto foi editado por um usuário. Por favor, verifique se há erros gramaticais ou de ortografia e corrija-os, 
mantendo o estilo e conteúdo original. Não adicione nem remova informações significativas:

${editedText}

Retorne apenas o texto corrigido, sem comentários adicionais.`;
                
                enhancedText = await callTogetherAPI(prompt);
                console.log('Texto aprimorado com sucesso');
            } catch (enhanceError) {
                console.error('Erro ao aprimorar texto:', enhanceError);
                // Se houver erro no aprimoramento, apenas use o texto original editado
                // mas não interrompa o fluxo com um erro
            }
        }
        
        sendProgressEvent('text_saved', 'Texto salvo com sucesso!');
        
        // Garantir que estamos enviando uma resposta JSON válida
        return res.json({
            success: true,
            message: 'Texto editado salvo com sucesso',
            originalText,
            editedText,
            enhancedText: req.body.enhance ? enhancedText : null,
            context
        });
    } catch (error) {
        console.error('Erro ao salvar texto editado:', error);
        
        // Garantir que sempre retornamos JSON, mesmo em caso de erro
        return res.status(500).json({ 
            error: `Erro ao salvar texto: ${error.message}`,
            success: false
        });
    }
});

// Rotas para gerenciar artigos salvos
app.post('/api/articles', requireAuth, (req, res) => {
    const { article_id, title, subtitle, content, tags, keyword, html } = req.body;
    const user_id = req.session.userId;
    
    console.log('Tentando salvar artigo:', { 
        title, 
        userId: user_id,
        sessionExists: !!req.session,
        sessionId: req.session?.id
    });
    
    if (!title || !content) {
        return res.status(400).json({ message: 'Título e conteúdo são obrigatórios' });
    }
    
    if (!user_id) {
        console.error('Erro: Usuário não autenticado ao tentar salvar artigo');
        return res.status(401).json({ message: 'Usuário não autenticado' });
    }
    
    db.run(
        'INSERT INTO articles (user_id, title, subtitle, content, tags, keyword, html) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [user_id, title, subtitle, content, tags, keyword, html],
        function(err) {
            if (err) {
                console.error('Erro ao salvar artigo:', err);
                return res.status(500).json({ message: 'Erro ao salvar artigo' });
            }
            
            res.status(201).json({
                message: 'Artigo salvo com sucesso',
                id: this.lastID
            });
        }
    );
});

app.get('/api/articles', requireAuth, (req, res) => {
    const user_id = req.session.userId;
    
    db.all('SELECT * FROM articles WHERE user_id = ? ORDER BY id DESC', [user_id], (err, articles) => {
        if (err) {
            console.error('Erro ao buscar artigos:', err);
            return res.status(500).json({ message: 'Erro ao buscar artigos' });
        }
        
        res.json(articles);
    });
});

app.get('/api/articles/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const user_id = req.session.userId;
    
    db.get('SELECT * FROM articles WHERE id = ? AND user_id = ?', [id, user_id], (err, article) => {
        if (err) {
            console.error('Erro ao buscar artigo:', err);
            return res.status(500).json({ message: 'Erro ao buscar artigo' });
        }
        
        if (!article) {
            return res.status(404).json({ message: 'Artigo não encontrado' });
        }
        
        res.json(article);
    });
});

app.delete('/api/articles/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const user_id = req.session.userId;
    
    db.run('DELETE FROM articles WHERE id = ? AND user_id = ?', [id, user_id], function(err) {
        if (err) {
            console.error('Erro ao excluir artigo:', err);
            return res.status(500).json({ message: 'Erro ao excluir artigo' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ message: 'Artigo não encontrado ou não pertence ao usuário' });
        }
        
        res.json({ message: 'Artigo excluído com sucesso' });
    });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
});

// Nova função de transcrição usando AssemblyAI
async function transcribeWithAssemblyAI(audioPath) {
    try {
        const apiKey = ASSEMBLYAI_API_KEY;
        if (!apiKey) {
            throw new Error('ASSEMBLYAI_API_KEY não configurada');
        }
        
        console.log('Iniciando upload do arquivo para AssemblyAI...');
        sendProgressEvent('transcription_progress', 'Enviando áudio para transcrição...');
        
        // 1. Upload do arquivo
        const audioData = await fs.readFile(audioPath);
        const uploadResponse = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
            headers: {
                'authorization': apiKey,
                'content-type': 'application/octet-stream'
            }
        });
        
        if (!uploadResponse.data || !uploadResponse.data.upload_url) {
            throw new Error('Falha no upload do áudio');
        }
        
        console.log('Áudio enviado, solicitando transcrição...');
        sendProgressEvent('transcription_progress', 'Processando transcrição...');
        
        // 2. Solicitar transcrição
        const transcriptResponse = await axios.post('https://api.assemblyai.com/v2/transcript', {
            audio_url: uploadResponse.data.upload_url,
            language_code: 'pt'
        }, {
            headers: { 'authorization': apiKey }
        });
        
        if (!transcriptResponse.data || !transcriptResponse.data.id) {
            throw new Error('Falha ao iniciar transcrição');
        }
        
        // 3. Aguardar conclusão
        const transcriptId = transcriptResponse.data.id;
        let status = 'processing';
        let attempts = 0;
        
        while (status === 'processing' && attempts < 30) { // 5 minutos max
            await new Promise(resolve => setTimeout(resolve, 10000)); // 10s
            attempts++;
            
            sendProgressEvent('transcription_progress', `Aguardando transcrição... (${attempts}/30)`);
            
            const statusResponse = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
                headers: { 'authorization': apiKey }
            });
            
            status = statusResponse.data.status;
            console.log(`Status da transcrição: ${status} (tentativa ${attempts})`);
            
            if (status === 'completed') {
                const transcriptionText = statusResponse.data.text || '';
                if (transcriptionText.trim()) {
                    console.log('Transcrição concluída com sucesso!');
                    return cleanTranscription(transcriptionText);
                } else {
                    console.log('Transcrição retornou texto vazio');
                    return '[Nenhuma fala detectada no áudio]';
                }
            } else if (status === 'error') {
                throw new Error(`Erro na transcrição AssemblyAI: ${statusResponse.data.error || 'Erro desconhecido'}`);
            }
        }
        
        throw new Error('Timeout na transcrição AssemblyAI');
        
    } catch (error) {
        console.error('Erro AssemblyAI:', error.message);
        throw error; // Propagar erro para tratamento no extractAudioInfo
    }
}

// Função para salvar transcrição em arquivo
async function saveTranscription(transcription, videoId) {
    try {
        // Criar pasta de transcrições se não existir
        const transcriptionsDir = './transcriptions';
        if (!fsSync.existsSync(transcriptionsDir)) {
            await fs.mkdir(transcriptionsDir);
        }

        // Gerar nome do arquivo baseado no ID do vídeo e timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${transcriptionsDir}/transcricao_${videoId}_${timestamp}.txt`;

        // Salvar transcrição no arquivo
        await fs.writeFile(fileName, transcription, 'utf8');
        console.log(`Transcrição salva em: ${fileName}`);
        return fileName;
    } catch (error) {
        console.error('Erro ao salvar transcrição:', error);
        return null;
    }
}

// Função para formatar o conteúdo extraído
function formatExtractedContent(content) {
    if (!content) return '';
    
    let formatted = '';
    
    // Título
    formatted += `${content.title}\n`;
    formatted += `Fonte: ${content.url}\n\n`;
    
    // Informações do autor e postagem
    if (content.author) {
        formatted += `👤 Autor: ${content.author}\n`;
    }
    
    if (content.postText) {
        formatted += `📝 Postagem: ${content.postText}\n\n`;
    }
    
    // Se tiver vídeo, adicionar informações
    if (content.hasVideo && content.videoInfo) {
        formatted += `🎥 Informações do Vídeo:\n`;
        formatted += `- Resolução: ${content.videoInfo.width}x${content.videoInfo.height}\n`;
        formatted += `- Duração: ${content.videoInfo.duration} segundos\n`;
        formatted += `- Tamanho: ${content.videoInfo.size}\n\n`;
        
        // Adicionar transcrição se disponível
        if (content.transcription && !content.transcription.startsWith('[')) {
            formatted += `🎙️ Transcrição do Áudio:\n${content.transcription}\n\n`;
        }
        
        // Adicionar link para o arquivo de transcrição
        if (content.transcriptionFile) {
            formatted += `📄 Arquivo de transcrição salvo em: ${content.transcriptionFile}\n\n`;
        }
    }
    
    // Adicionar comentários se houver
    if (content.comments && content.comments.length > 0) {
        formatted += `💬 Comentários (${content.comments.length}):\n`;
        content.comments.forEach((comment, index) => {
            formatted += `${index + 1}. ${comment}\n`;
        });
        formatted += '\n';
    }
    
    // Adicionar contagem de palavras
    formatted += `📊 Total de palavras: ${content.wordCount}\n`;
    
    return formatted;
}