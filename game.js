// 猜数字游戏辅助工具 - 核心引擎
// 使用 Web Worker 进行候选池计算，避免阻塞主线程

class NumberGuesser {
    constructor() {
        // 游戏状态
        this.secretNumber = '';
        this.isFirstMove = true;
        this.isPaused = false;
        this.roundCount = 0;
        this.guessCount = 0;

        // 进攻数据
        this.candidates = [];
        this.attackHistory = [];
        this.currentGuess = '';
        this.currentA = -1;

        // 防守数据
        this.defenseHistory = [];

        // Web Worker 用于候选池计算
        this.worker = null;
        this.initWorker();
    }

    // 初始化 Web Worker
    initWorker() {
        const workerCode = `
            // 计算两个数字的匹配值（A值）
            function calculateMatch(guess, secret) {
                let match = 0;
                for (let i = 0; i < 4; i++) {
                    if (guess[i] === secret[i]) {
                        match++;
                    }
                }
                return match;
            }

            // 使用 Uint16Array 压缩存储候选池
            let candidates = new Uint16Array(10000);
            for (let i = 0; i < 10000; i++) {
                candidates[i] = i;
            }
            let candidateCount = 10000;

            // 根据历史反馈过滤候选池
            function filterCandidates(history) {
                let valid = [];
                for (let i = 0; i < candidateCount; i++) {
                    let num = candidates[i];
                    let secretStr = num.toString().padStart(4, '0');
                    let isValid = true;

                    for (let h of history) {
                        let match = calculateMatch(h.guess, secretStr);
                        if (match !== h.a) {
                            isValid = false;
                            break;
                        }
                    }

                    if (isValid) {
                        valid.push(num);
                    }
                }

                // 更新候选池
                candidates = new Uint16Array(valid.length);
                for (let i = 0; i < valid.length; i++) {
                    candidates[i] = valid[i];
                }
                candidateCount = valid.length;

                return {
                    candidates: Array.from(valid).map(n => n.toString().padStart(4, '0')),
                    count: valid.length
                };
            }

            // 使用信息熵策略选择最佳猜测
            function selectBestGuess(currentCandidates, history) {
                if (currentCandidates.length === 0) {
                    return null;
                }

                // 如果候选池很小，直接返回第一个
                if (currentCandidates.length <= 10) {
                    return currentCandidates[0];
                }

                // 计算每个可能的猜测的信息熵
                let bestGuess = null;
                let bestScore = -1;

                // 采样部分数字进行评估（提高性能）
                const sampleSize = Math.min(500, currentCandidates.length);
                const samples = [];

                // 优先采样包含不同数字的组合
                for (let i = 0; i < sampleSize && i < currentCandidates.length; i++) {
                    samples.push(currentCandidates[i]);
                }

                // 添加一些启发式猜测
                const heuristicGuesses = ['1234', '5678', '9012', '3456', '7890', '1357', '2468', '1122', '3344', '5566'];
                for (let guess of heuristicGuesses) {
                    if (!samples.includes(guess)) {
                        samples.push(guess);
                    }
                }

                for (let guess of samples) {
                    // 计算这个猜测能将候选池分割成多少部分
                    let buckets = new Array(5).fill(0);

                    for (let candidate of currentCandidates) {
                        let match = calculateMatch(guess, candidate);
                        buckets[match]++;
                    }

                    // 计算信息熵（希望分割尽可能均匀）
                    let entropy = 0;
                    for (let bucket of buckets) {
                        if (bucket > 0) {
                            let p = bucket / currentCandidates.length;
                            entropy -= p * Math.log2(p);
                        }
                    }

                    // 如果这个猜测本身在候选池中，给予额外权重
                    let inCandidates = currentCandidates.includes(guess) ? 1 : 0.5;

                    let score = entropy * inCandidates;

                    if (score > bestScore) {
                        bestScore = score;
                        bestGuess = guess;
                    }
                }

                return bestGuess || currentCandidates[0];
            }

            // 监听主线程消息
            self.onmessage = function(e) {
                const { type, data } = e.data;

                switch (type) {
                    case 'filter':
                        const result = filterCandidates(data.history);
                        self.postMessage({ type: 'filterResult', data: result });
                        break;

                    case 'suggest':
                        const bestGuess = selectBestGuess(data.candidates, data.history);
                        self.postMessage({ type: 'suggestion', data: bestGuess });
                        break;

                    case 'calculateA':
                        const match = calculateMatch(data.guess, data.secret);
                        self.postMessage({ type: 'aResult', data: match });
                        break;
                }
            };
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));

        this.worker.onmessage = (e) => {
            const { type, data } = e.data;
            switch (type) {
                case 'filterResult':
                    this.onFilterResult(data);
                    break;
                case 'suggestion':
                    this.onSuggestion(data);
                    break;
                case 'aResult':
                    this.onAResult(data);
                    break;
            }
        };
    }

    // 过滤候选池后的回调
    onFilterResult(data) {
        this.candidates = data.candidates;
        this.updateUI();

        // 自动生成下一个建议
        this.generateSuggestion();
    }

    // 收到建议后的回调
    onSuggestion(data) {
        if (data) {
            document.getElementById('suggestionNumber').textContent = data;
            document.getElementById('suggestionInfo').textContent = `剩余候选: ${this.candidates.length} 个`;
        }
    }

    // 收到A值计算结果的回调
    onAResult(data) {
        document.getElementById('aResult').textContent = data;
    }

    // 生成建议
    generateSuggestion() {
        if (this.candidates.length === 0) {
            document.getElementById('suggestionNumber').textContent = '无解';
            document.getElementById('suggestionInfo').textContent = '请检查历史记录是否有误';
            return;
        }

        this.worker.postMessage({
            type: 'suggest',
            data: {
                candidates: this.candidates,
                history: this.attackHistory
            }
        });
    }

    // 提交反馈并更新候选池
    submitFeedback(guess, aValue) {
        // 添加到历史记录
        this.attackHistory.push({
            round: this.attackHistory.length + 1,
            guess: guess,
            a: aValue
        });

        this.guessCount++;

        // 检查是否获胜
        if (aValue === 4) {
            this.showVictory(true);
            return;
        }

        // 过滤候选池
        this.worker.postMessage({
            type: 'filter',
            data: {
                history: this.attackHistory
            }
        });

        this.updateAttackHistory();
    }

    // 计算A值（防守时使用）
    calculateA(guess) {
        return new Promise((resolve) => {
            const handler = (e) => {
                if (e.data.type === 'aResult') {
                    this.worker.removeEventListener('message', handler);
                    resolve(e.data.data);
                }
            };
            this.worker.addEventListener('message', handler);

            this.worker.postMessage({
                type: 'calculateA',
                data: {
                    guess: guess,
                    secret: this.secretNumber
                }
            });
        });
    }

    // 更新UI
    updateUI() {
        document.getElementById('candidateCount').textContent = this.candidates.length;
        document.getElementById('roundCount').textContent = this.roundCount;
        document.getElementById('guessCount').textContent = this.guessCount;

        // 更新进度条
        const progress = this.candidates.length > 0 ?
            Math.min(100, ((10000 - this.candidates.length) / 10000) * 100) : 100;
        document.getElementById('progressFill').style.width = `${progress}%`;
        document.getElementById('progressText').textContent = `${progress.toFixed(1)}%`;
    }

    // 更新进攻历史表格
    updateAttackHistory() {
        const tbody = document.getElementById('attackHistory');
        if (this.attackHistory.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">暂无记录</td></tr>';
            return;
        }

        tbody.innerHTML = this.attackHistory.map(h => {
            const aClass = h.a >= 3 ? 'high' : h.a >= 2 ? 'medium' : 'low';
            return `
                <tr>
                    <td>${h.round}</td>
                    <td class="history-number">${h.guess}</td>
                    <td><span class="a-value ${aClass}">${h.a}</span></td>
                </tr>
            `;
        }).join('');
    }

    // 更新防守历史表格
    updateDefenseHistory() {
        const tbody = document.getElementById('defenseHistory');
        if (this.defenseHistory.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">暂无记录</td></tr>';
            return;
        }

        tbody.innerHTML = this.defenseHistory.map(h => {
            const aClass = h.a >= 3 ? 'high' : h.a >= 2 ? 'medium' : 'low';
            return `
                <tr>
                    <td>${h.round}</td>
                    <td class="history-number">${h.guess}</td>
                    <td><span class="a-value ${aClass}">${h.a}</span></td>
                </tr>
            `;
        }).join('');
    }

    // 添加防守记录
    addDefenseRecord(guess, aValue) {
        this.defenseHistory.push({
            round: this.defenseHistory.length + 1,
            guess: guess,
            a: aValue
        });

        this.roundCount++;

        // 检查对方是否获胜
        if (aValue === 4) {
            this.showVictory(false);
            return;
        }

        // 高A值警告
        if (aValue >= 3) {
            document.getElementById('defenseHint').textContent = '⚠️ 警告：对方接近猜中！';
            document.getElementById('defenseHint').classList.add('show');
        }

        // 检测对方策略
        this.detectOpponentStrategy();
        this.updateDefenseHistory();
    }

    // 检测对方策略
    detectOpponentStrategy() {
        if (this.defenseHistory.length < 3) return;

        const lastThree = this.defenseHistory.slice(-3);
        const digits = new Set();

        for (let record of lastThree) {
            for (let digit of record.guess) {
                digits.add(digit);
            }
        }

        // 如果对方连续猜测使用相似的数字组合
        if (digits.size <= 5) {
            document.getElementById('defenseHint').textContent = '💡 注意：对方可能在尝试数字排列组合！';
            document.getElementById('defenseHint').classList.add('show');
        }
    }

    // 显示胜利/失败
    showVictory(isWin) {
        const overlay = document.getElementById('victoryOverlay');
        const text = document.getElementById('victoryText');

        if (isWin) {
            text.textContent = '🎉 你猜中了对方的数字！';
            this.createParticles();
        } else {
            text.textContent = '❗ 对方猜中了你的数字！';
        }

        overlay.classList.add('show');
    }

    // 关闭胜利提示
    closeVictory() {
        document.getElementById('victoryOverlay').classList.remove('show');
    }

    // 创建粒子特效
    createParticles() {
        const container = document.getElementById('particles');
        const colors = ['#FFD700', '#FFA500', '#FF6347', '#00CED1', '#9370DB'];

        for (let i = 0; i < 50; i++) {
            const particle = document.createElement('div');
            particle.className = 'particle';
            particle.style.left = Math.random() * 100 + '%';
            particle.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            particle.style.animationDelay = Math.random() * 2 + 's';
            particle.style.animationDuration = (2 + Math.random() * 2) + 's';
            container.appendChild(particle);
        }

        setTimeout(() => {
            container.innerHTML = '';
        }, 5000);
    }

    // 保存游戏状态
    saveState() {
        const state = {
            secretNumber: this.secretNumber,
            isFirstMove: this.isFirstMove,
            roundCount: this.roundCount,
            guessCount: this.guessCount,
            attackHistory: this.attackHistory,
            defenseHistory: this.defenseHistory,
            candidates: this.candidates
        };
        localStorage.setItem('guesserState', JSON.stringify(state));
    }

    // 加载游戏状态
    loadState() {
        const saved = localStorage.getItem('guesserState');
        if (saved) {
            const state = JSON.parse(saved);
            Object.assign(this, state);
            return true;
        }
        return false;
    }

    // 重置游戏
    reset() {
        this.secretNumber = '';
        this.isFirstMove = true;
        this.isPaused = false;
        this.roundCount = 0;
        this.guessCount = 0;
        this.candidates = [];
        this.attackHistory = [];
        this.defenseHistory = [];
        this.currentGuess = '';
        this.currentA = -1;
        localStorage.removeItem('guesserState');
    }

    // 导出记录
    exportRecords() {
        let output = '=== 猜数字游戏记录 ===\n\n';
        output += `秘密数字: ${this.secretNumber}\n`;
        output += `先后手: ${this.isFirstMove ? '先手' : '后手'}\n\n`;

        output += '【进攻记录】\n';
        for (let h of this.attackHistory) {
            output += `回合${h.round}: 猜 ${h.guess} → A=${h.a}\n`;
        }

        output += '\n【防守记录】\n';
        for (let h of this.defenseHistory) {
            output += `回合${h.round}: 对方猜 ${h.guess} → A=${h.a}\n`;
        }

        output += `\n剩余候选数: ${this.candidates.length}\n`;
        output += `总回合数: ${this.roundCount}\n`;

        return output;
    }
}

// 游戏控制器
class GameController {
    constructor() {
        this.guesser = new NumberGuesser();
        this.initEventListeners();
    }

    initEventListeners() {
        // 秘密数字眼睛图标
        document.getElementById('secretEye').addEventListener('click', () => {
            const input = document.getElementById('secretInput');
            const eye = document.getElementById('secretEye');
            if (input.type === 'password') {
                input.type = 'text';
                eye.textContent = '🙈';
            } else {
                input.type = 'password';
                eye.textContent = '👁️';
            }
        });

        // 秘密数字显示切换
        document.getElementById('secretDisplay').addEventListener('click', () => {
            const display = document.getElementById('secretDisplay');
            if (display.textContent === '●●●●') {
                display.textContent = this.guesser.secretNumber;
            } else {
                display.textContent = '●●●●';
            }
        });

        // 开始游戏
        document.getElementById('startGameBtn').addEventListener('click', () => this.startGame());

        // 使用建议
        document.getElementById('useSuggestionBtn').addEventListener('click', () => this.useSuggestion());

        // 自定义猜测
        document.getElementById('customGuessBtn').addEventListener('click', () => {
            const area = document.getElementById('customGuessArea');
            area.style.display = area.style.display === 'none' ? 'block' : 'none';
        });

        // 提交自定义猜测
        document.getElementById('submitCustomGuess').addEventListener('click', () => this.submitCustomGuess());

        // 提交反馈
        document.getElementById('submitFeedbackBtn').addEventListener('click', () => this.submitFeedback());

        // 计算A值
        document.getElementById('calculateABtn').addEventListener('click', () => this.calculateA());

        // 标签页切换
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab + 'Tab').classList.add('active');
            });
        });

        // 暂停按钮
        document.getElementById('pauseBtn').addEventListener('click', () => {
            this.guesser.isPaused = !this.guesser.isPaused;
            document.getElementById('pauseBtn').textContent = this.guesser.isPaused ? '▶️ 继续' : '⏸️ 暂停';
        });

        // 重新开始
        document.getElementById('restartBtn').addEventListener('click', () => {
            if (confirm('确定要重新开始吗？当前进度将丢失。')) {
                location.reload();
            }
        });

        // 导出记录
        document.getElementById('exportBtn').addEventListener('click', () => {
            const records = this.guesser.exportRecords();
            const blob = new Blob([records], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `猜数字记录_${new Date().toLocaleString()}.txt`;
            a.click();
        });

        // 快速隐藏
        document.getElementById('hideBtn').addEventListener('click', () => {
            document.getElementById('calculatorDisguise').classList.add('show');
        });

        // 退出伪装
        document.getElementById('exitDisguise').addEventListener('click', () => {
            document.getElementById('calculatorDisguise').classList.remove('show');
        });

        // 防窥模式
        document.getElementById('privacyMode').addEventListener('change', (e) => {
            if (e.target.checked) {
                document.body.classList.add('privacy-blur');
            } else {
                document.body.classList.remove('privacy-blur');
            }
        });

        // 输入验证
        document.getElementById('secretInput').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
        });

        document.getElementById('customGuessInput').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
        });

        document.getElementById('defenseInput').addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
        });

        // 双击复制建议数字
        document.getElementById('suggestionNumber').addEventListener('dblclick', () => {
            const text = document.getElementById('suggestionNumber').textContent;
            if (text !== '????' && text !== '无解') {
                navigator.clipboard.writeText(text);
                alert('已复制: ' + text);
            }
        });

        // 移动端手势
        let touchStartX = 0;
        document.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
        });

        document.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].clientX;
            const diff = touchStartX - touchEndX;

            if (Math.abs(diff) > 50) {
                const tabs = document.querySelectorAll('.tab');
                if (diff > 0) {
                    // 左滑
                    tabs[1].click();
                } else {
                    // 右滑
                    tabs[0].click();
                }
            }
        });

        // 检测移动端
        if ('ontouchstart' in window) {
            document.querySelector('.mobile-action-area').style.display = 'block';
        }
    }

    startGame() {
        const secret = document.getElementById('secretInput').value;
        if (secret.length !== 4) {
            alert('请输入完整的4位数字！');
            return;
        }

        this.guesser.secretNumber = secret;
        this.guesser.isFirstMove = document.getElementById('firstMove').checked;

        // 初始化候选池
        this.guesser.candidates = Array.from({ length: 10000 }, (_, i) =>
            i.toString().padStart(4, '0')
        );

        // 更新显示
        document.getElementById('secretDisplay').dataset.secret = secret;

        // 切换界面
        document.getElementById('initScreen').classList.add('hidden');
        document.getElementById('gameScreen').classList.add('show');

        // 生成第一个建议
        this.guesser.generateSuggestion();
        this.guesser.updateUI();
    }

    useSuggestion() {
        const suggestion = document.getElementById('suggestionNumber').textContent;
        if (suggestion === '????' || suggestion === '无解') {
            alert('暂无可用建议！');
            return;
        }

        this.guesser.currentGuess = suggestion;
        document.getElementById('currentGuess').textContent = suggestion;

        // 复制到剪贴板
        navigator.clipboard.writeText(suggestion);
        alert(`已复制建议数字: ${suggestion}\n请告诉对方，然后输入对方反馈的A值`);
    }

    submitCustomGuess() {
        const input = document.getElementById('customGuessInput');
        const guess = input.value.padStart(4, '0');

        if (guess.length !== 4) {
            alert('请输入完整的4位数字！');
            return;
        }

        this.guesser.currentGuess = guess;
        document.getElementById('currentGuess').textContent = guess;
        input.value = '';
        document.getElementById('customGuessArea').style.display = 'none';

        // 复制到剪贴板
        navigator.clipboard.writeText(guess);
        alert(`已复制: ${guess}\n请告诉对方，然后输入对方反馈的A值`);
    }

    submitFeedback() {
        const aValue = parseInt(document.getElementById('feedbackA').value);

        if (isNaN(aValue) || aValue < 0 || aValue > 4) {
            alert('请输入有效的A值（0-4）！');
            return;
        }

        if (!this.guesser.currentGuess) {
            alert('请先选择或输入猜测数字！');
            return;
        }

        this.guesser.submitFeedback(this.guesser.currentGuess, aValue);
        document.getElementById('feedbackA').value = '';
        this.guesser.currentGuess = '';
        document.getElementById('currentGuess').textContent = '等待猜测...';
    }

    async calculateA() {
        const input = document.getElementById('defenseInput');
        const guess = input.value.padStart(4, '0');

        if (guess.length !== 4) {
            alert('请输入完整的4位数字！');
            return;
        }

        const aValue = await this.guesser.calculateA(guess);
        document.getElementById('aResult').textContent = aValue;

        // 自动添加到防守历史
        this.guesser.addDefenseRecord(guess, aValue);
        input.value = '';
    }
}

// 初始化游戏
const game = new GameController();
