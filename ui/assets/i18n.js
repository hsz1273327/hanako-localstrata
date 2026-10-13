// hanako-localstrata UI i18n.
//
// Six locales: zh / en / fr / ru / ja / ko. Technical terms that have no
// stable translation in the local-inference world (KV, prefill, token, MTP,
// temperature, top_p, tg / pp …) stay in their original form on purpose.
//
// Usage from the panel:
//   import { LANGS, LANG_NAMES, detectLang, loadLang, saveLang, setLang,
//            getLang, t, tp, applyI18n } from "./i18n.js";
//   setLang(loadLang());
//   applyI18n();
//   t("state.running");            // localized string
//   tp("update.progressStep", { n: 1, total: 5, label: "…" });

export const LANGS = ["zh", "en", "fr", "ru", "ja", "ko"];

// Endonyms, so the picker reads naturally in every locale.
export const LANG_NAMES = {
  zh: "中文",
  en: "English",
  fr: "Français",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
};

export const STRINGS = {
  zh: {
    appName: "Strata 控制台",

    "common.refresh": "刷新",
    "common.copy": "复制",
    "common.copied": "已复制",
    "common.selected": "已选中",
    "common.save": "保存",
    "common.saveRestart": "保存并重启",
    "common.update": "更新",
    "common.confirm": "确认",
    "common.cancel": "取消",
    "common.working": "正在…",

    "group.version": "版本",
    "group.config": "服务配置",
    "group.speed": "性能",
    "group.resource": "资源占用",
    "group.logs": "日志",
    "group.edit": "参数编辑",

    "label.model": "模型",
    "label.uptime": "运行时长",
    "label.port": "端口",
    "label.address": "地址",
    "label.apiKey": "API Key",
    "label.version": "版本",
    "label.latestVersion": "最新版本",
    "label.context": "上下文",
    "label.kv": "KV 量化",
    "label.sessionCache": "会话缓存",
    "label.reasoningEffort": "思考档位",
    "label.tg": "生成 tg",
    "label.pp": "预填 pp",
    "label.expertCache": "专家缓存",
    "label.kvHit": "KV 命中",

    "state.checking": "检测中…",
    "state.running": "运行中",
    "state.starting": "加载中…",
    "state.stopping": "停止中…",
    "state.restarting": "重启中…",
    "state.unconfigured": "未配置",
    "state.notInstalled": "未安装",
    "state.pythonMissing": "Python 不可用",
    "state.needsConfig": "待选择配置",
    "state.noConfig": "缺少配置",
    "state.stopped": "已停止",

    "netMode.local": "本地",
    "netMode.lan": "局域网",
    "modeBtn.local": "本地模式（点击切换到局域网）",
    "modeBtn.lan": "局域网模式（点击切换回本地）",

    "action.start": "启动服务",
    "action.stop": "停止服务",
    "action.starting": "启动中…",

    "version.available": "{version} 可用 ⚠️",
    "version.upToDate": "✅ 已是最新",
    "version.checkFailed": "检查失败",
    "version.checking": "检查中…",

    "resource.gpu": "显存",
    "resource.mem": "内存",
    "resource.gpuAria": "显存占用",
    "resource.memAria": "内存占用",

    "edit.startupLegend": "启动参数",
    "edit.samplingLegend": "采样参数",
    "edit.sharedLegend": "共享设置",
    "edit.needsRestart": "需重启",
    "edit.takesEffect": "即时生效",
    "edit.context": "上下文长度",
    "edit.kv": "KV 量化",
    "edit.sessionCache": "会话缓存 (MB)",
    "edit.maxTokens": "最大输出",
    "edit.reasoningEffort": "思考档位",
    "edit.pendingDiff": "待保存改动",
    "edit.noChange": "没有变化",
    "edit.noEdits": "没有可保存的改动",
    "edit.saving": "正在保存…",
    "edit.savingRestart": "正在保存并重启…",
    "edit.saved": "已保存 {count} 项改动{backups}{restart}",
    "edit.backups": " 已备份: {list}",
    "edit.restartRequired": "（需重启生效）",

    "overlay.forceRefresh": "强制刷新",
    "overlay.viewFullLog": "查看完整日志",
    "overlay.hideLog": "收起日志",
    "overlay.timeout": "操作超时，请手动刷新",
    "overlay.start": "正在启动服务…",
    "overlay.startHint": "首次约需 2 分钟",
    "overlay.stop": "正在停止服务…",
    "overlay.restart": "正在重启服务…",
    "overlay.restartHint": "约需 1-2 分钟",

    "unsupported.title": "不支持 macOS",
    "unsupported.message": "Strata 目前只支持 Windows 和 Linux，不支持 macOS。",
    "unsupported.reason": "Strata 目前只支持 Windows 和 Linux。",
    "unsupported.projectUrl": "项目地址：",

    "setup.notInstalledTitle": "在以下路径没有找到 Strata：",
    "setup.notInstalledSub": "请确认路径，或先安装 Strata",
    "setup.pythonMissingHint": "Python 解释器不存在",
    "setup.saveAndDetect": "保存并检测",
    "setup.savingDetect": "正在保存并检测…",
    "setup.saved": "已保存",
    "setup.needDir": "请填写 Strata 目录",
    "setup.chooseConfig": "找到以下配置文件，请选择一个：",
    "setup.autoSelected": "已自动选择：{file}",
    "setup.useThis": "使用此配置",
    "setup.useSelected": "使用选中的配置",
    "setup.selected": "已选择",
    "setup.noConfigTitle": "目录下未找到配置文件",
    "setup.noConfigSub": "已扫描 {dir}，未发现 strata-*.json。请先用 setup.py 生成配置，或到 Hana 设置页修正目录。",
    "setup.candidateContext": "上下文 {context}",

    "confirm.stopTitle": "确认停止服务？",
    "confirm.stopAction": "停止",
    "confirm.switchModeTitle": "切换网络模式需重启",
    "confirm.switchModeSub": "重启期间服务不可用（约 2 分钟）",
    "confirm.restartAction": "确认重启",

    "update.confirmTitle": "更新到 v{version}？",
    "update.confirmTitlePlain": "更新 Strata？",
    "update.confirmSub": "需停止服务并重新编译（15-25 分钟）",
    "update.confirmAction": "确认更新",
    "update.running": "⟳ 正在更新 Strata…",
    "update.steps": "停止服务 → 拉取代码 → 编译引擎 → 重启",
    "update.progress": "正在更新…",
    "update.progressStep": "正在更新…第 {n}/{total} 步{label}",
    "update.progressLabel": "（{label}）",
    "update.failed": "更新失败",
    "update.unknownError": "未知错误",
    "update.logFileEmpty": "日志文件：{path}\n（暂无内容）",

    "error.authFailed": "Strata 已运行，但 API Key 无效，状态信息不完整",

    "lang.label": "语言",
    "field.strataDir": "Strata 目录",
    "field.pythonPath": "Python 解释器",
    "field.pythonPathPlaceholder": "留空则使用系统 Python（python3）",
  },

  en: {
    appName: "Strata Console",

    "common.refresh": "Refresh",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.selected": "Selected",
    "common.save": "Save",
    "common.saveRestart": "Save & restart",
    "common.update": "Update",
    "common.confirm": "Confirm",
    "common.cancel": "Cancel",
    "common.working": "Working…",

    "group.version": "Version",
    "group.config": "Service",
    "group.speed": "Performance",
    "group.resource": "Resources",
    "group.logs": "Logs",
    "group.edit": "Parameters",

    "label.model": "Model",
    "label.uptime": "Uptime",
    "label.port": "Port",
    "label.address": "Address",
    "label.apiKey": "API Key",
    "label.version": "Version",
    "label.latestVersion": "Latest",
    "label.context": "Context",
    "label.kv": "KV quant",
    "label.sessionCache": "Session cache",
    "label.reasoningEffort": "Reasoning",
    "label.tg": "Gen tg",
    "label.pp": "Prefill pp",
    "label.expertCache": "Expert cache",
    "label.kvHit": "KV hit",

    "state.checking": "Checking…",
    "state.running": "Running",
    "state.starting": "Loading…",
    "state.stopping": "Stopping…",
    "state.restarting": "Restarting…",
    "state.unconfigured": "Not configured",
    "state.notInstalled": "Not installed",
    "state.pythonMissing": "Python unavailable",
    "state.needsConfig": "Select config",
    "state.noConfig": "No config",
    "state.stopped": "Stopped",

    "netMode.local": "Local",
    "netMode.lan": "LAN",
    "modeBtn.local": "Local mode (click to switch to LAN)",
    "modeBtn.lan": "LAN mode (click to switch back to local)",

    "action.start": "Start service",
    "action.stop": "Stop service",
    "action.starting": "Starting…",

    "version.available": "{version} available ⚠️",
    "version.upToDate": "✅ Up to date",
    "version.checkFailed": "Check failed",
    "version.checking": "Checking…",

    "resource.gpu": "VRAM",
    "resource.mem": "RAM",
    "resource.gpuAria": "VRAM usage",
    "resource.memAria": "RAM usage",

    "edit.startupLegend": "Startup",
    "edit.samplingLegend": "Sampling",
    "edit.sharedLegend": "Shared",
    "edit.needsRestart": "restart required",
    "edit.takesEffect": "takes effect now",
    "edit.context": "Context length",
    "edit.kv": "KV quantization",
    "edit.sessionCache": "Session cache (MB)",
    "edit.maxTokens": "Max output",
    "edit.reasoningEffort": "Reasoning effort",
    "edit.pendingDiff": "Pending changes",
    "edit.noChange": "No changes",
    "edit.noEdits": "Nothing to save",
    "edit.saving": "Saving…",
    "edit.savingRestart": "Saving and restarting…",
    "edit.saved": "Saved {count} change(s){backups}{restart}",
    "edit.backups": " · backed up: {list}",
    "edit.restartRequired": " (restart required)",

    "overlay.forceRefresh": "Force refresh",
    "overlay.viewFullLog": "View full log",
    "overlay.hideLog": "Hide log",
    "overlay.timeout": "Timed out — refresh manually",
    "overlay.start": "Starting service…",
    "overlay.startHint": "About 2 minutes on first start",
    "overlay.stop": "Stopping service…",
    "overlay.restart": "Restarting service…",
    "overlay.restartHint": "About 1–2 minutes",

    "unsupported.title": "macOS not supported",
    "unsupported.message": "Strata currently supports Windows and Linux only, not macOS.",
    "unsupported.reason": "Strata currently supports Windows and Linux only.",
    "unsupported.projectUrl": "Project:",

    "setup.notInstalledTitle": "Strata not found at:",
    "setup.notInstalledSub": "Check the path, or install Strata first",
    "setup.pythonMissingHint": "Python interpreter not found",
    "setup.saveAndDetect": "Save & detect",
    "setup.savingDetect": "Saving and detecting…",
    "setup.saved": "Saved",
    "setup.needDir": "Enter the Strata directory",
    "setup.chooseConfig": "Found the following config files, pick one:",
    "setup.autoSelected": "Auto-selected: {file}",
    "setup.useThis": "Use this config",
    "setup.useSelected": "Use selected config",
    "setup.selected": "Selected",
    "setup.noConfigTitle": "No config file in this directory",
    "setup.noConfigSub": "Scanned {dir}, no strata-*.json found. Generate one with setup.py, or fix the directory in Hana settings.",
    "setup.candidateContext": "Context {context}",

    "confirm.stopTitle": "Stop the service?",
    "confirm.stopAction": "Stop",
    "confirm.switchModeTitle": "Switching network mode restarts",
    "confirm.switchModeSub": "Service is unavailable during the restart (~2 min)",
    "confirm.restartAction": "Restart",

    "update.confirmTitle": "Update to v{version}?",
    "update.confirmTitlePlain": "Update Strata?",
    "update.confirmSub": "Stops the service and rebuilds (15–25 min)",
    "update.confirmAction": "Update",
    "update.running": "⟳ Updating Strata…",
    "update.steps": "Stop → pull → build engine → restart",
    "update.progress": "Updating…",
    "update.progressStep": "Updating… step {n}/{total}{label}",
    "update.progressLabel": " ({label})",
    "update.failed": "Update failed",
    "update.unknownError": "Unknown error",
    "update.logFileEmpty": "Log file: {path}\n(empty)",

    "error.authFailed": "Strata is running but the API key is invalid; status is incomplete",

    "lang.label": "Language",
    "field.strataDir": "Strata directory",
    "field.pythonPath": "Python interpreter",
    "field.pythonPathPlaceholder": "Leave empty to use system Python (python3)",
  },

  fr: {
    appName: "Console Strata",

    "common.refresh": "Actualiser",
    "common.copy": "Copier",
    "common.copied": "Copié",
    "common.selected": "Sélectionné",
    "common.save": "Enregistrer",
    "common.saveRestart": "Enregistrer et redémarrer",
    "common.update": "Mettre à jour",
    "common.confirm": "Confirmer",
    "common.cancel": "Annuler",
    "common.working": "En cours…",

    "group.version": "Version",
    "group.config": "Service",
    "group.speed": "Performances",
    "group.resource": "Ressources",
    "group.logs": "Journaux",
    "group.edit": "Paramètres",

    "label.model": "Modèle",
    "label.uptime": "Durée",
    "label.port": "Port",
    "label.address": "Adresse",
    "label.apiKey": "Clé API",
    "label.version": "Version",
    "label.latestVersion": "Dernière",
    "label.context": "Contexte",
    "label.kv": "Quantification KV",
    "label.sessionCache": "Cache de session",
    "label.reasoningEffort": "Réflexion",
    "label.tg": "Gén. tg",
    "label.pp": "Prefill pp",
    "label.expertCache": "Cache experts",
    "label.kvHit": "Taux KV",

    "state.checking": "Vérification…",
    "state.running": "En cours",
    "state.starting": "Chargement…",
    "state.stopping": "Arrêt…",
    "state.restarting": "Redémarrage…",
    "state.unconfigured": "Non configuré",
    "state.notInstalled": "Non installé",
    "state.pythonMissing": "Python indisponible",
    "state.needsConfig": "Choisir un fichier",
    "state.noConfig": "Sans config",
    "state.stopped": "Arrêté",

    "netMode.local": "Local",
    "netMode.lan": "LAN",
    "modeBtn.local": "Mode local (cliquer pour passer en LAN)",
    "modeBtn.lan": "Mode LAN (cliquer pour revenir en local)",

    "action.start": "Démarrer le service",
    "action.stop": "Arrêter le service",
    "action.starting": "Démarrage…",

    "version.available": "{version} disponible ⚠️",
    "version.upToDate": "✅ À jour",
    "version.checkFailed": "Échec de la vérification",
    "version.checking": "Vérification…",

    "resource.gpu": "VRAM",
    "resource.mem": "RAM",
    "resource.gpuAria": "Utilisation VRAM",
    "resource.memAria": "Utilisation RAM",

    "edit.startupLegend": "Démarrage",
    "edit.samplingLegend": "Échantillonnage",
    "edit.sharedLegend": "Partagé",
    "edit.needsRestart": "redémarrage requis",
    "edit.takesEffect": "effet immédiat",
    "edit.context": "Longueur du contexte",
    "edit.kv": "Quantification KV",
    "edit.sessionCache": "Cache de session (Mo)",
    "edit.maxTokens": "Sortie max",
    "edit.reasoningEffort": "Effort de réflexion",
    "edit.pendingDiff": "Modifications en attente",
    "edit.noChange": "Aucun changement",
    "edit.noEdits": "Rien à enregistrer",
    "edit.saving": "Enregistrement…",
    "edit.savingRestart": "Enregistrement et redémarrage…",
    "edit.saved": "{count} modification(s) enregistrée(s){backups}{restart}",
    "edit.backups": " · sauvegarde : {list}",
    "edit.restartRequired": " (redémarrage requis)",

    "overlay.forceRefresh": "Forcer l'actualisation",
    "overlay.viewFullLog": "Voir le journal complet",
    "overlay.hideLog": "Masquer le journal",
    "overlay.timeout": "Délai dépassé — actualisez manuellement",
    "overlay.start": "Démarrage du service…",
    "overlay.startHint": "Environ 2 minutes au premier démarrage",
    "overlay.stop": "Arrêt du service…",
    "overlay.restart": "Redémarrage du service…",
    "overlay.restartHint": "Environ 1 à 2 minutes",

    "unsupported.title": "macOS non pris en charge",
    "unsupported.message": "Strata ne prend en charge que Windows et Linux, pas macOS.",
    "unsupported.reason": "Strata ne prend en charge que Windows et Linux.",
    "unsupported.projectUrl": "Projet :",

    "setup.notInstalledTitle": "Strata introuvable à l'emplacement :",
    "setup.notInstalledSub": "Vérifiez le chemin ou installez Strata d'abord",
    "setup.pythonMissingHint": "Interpréteur Python introuvable",
    "setup.saveAndDetect": "Enregistrer et détecter",
    "setup.savingDetect": "Enregistrement et détection…",
    "setup.saved": "Enregistré",
    "setup.needDir": "Saisissez le dossier Strata",
    "setup.chooseConfig": "Fichiers de configuration trouvés, choisissez-en un :",
    "setup.autoSelected": "Sélectionné automatiquement : {file}",
    "setup.useThis": "Utiliser cette config",
    "setup.useSelected": "Utiliser la config sélectionnée",
    "setup.selected": "Sélectionné",
    "setup.noConfigTitle": "Aucun fichier de configuration dans ce dossier",
    "setup.noConfigSub": "{dir} analysé, aucun strata-*.json trouvé. Générez-en un avec setup.py ou corrigez le dossier dans les réglages Hana.",
    "setup.candidateContext": "Contexte {context}",

    "confirm.stopTitle": "Arrêter le service ?",
    "confirm.stopAction": "Arrêter",
    "confirm.switchModeTitle": "Changer de mode réseau redémarre",
    "confirm.switchModeSub": "Service indisponible pendant le redémarrage (~2 min)",
    "confirm.restartAction": "Redémarrer",

    "update.confirmTitle": "Mettre à jour vers v{version} ?",
    "update.confirmTitlePlain": "Mettre à jour Strata ?",
    "update.confirmSub": "Arrête le service et recompile (15–25 min)",
    "update.confirmAction": "Mettre à jour",
    "update.running": "⟳ Mise à jour de Strata…",
    "update.steps": "Arrêt → récupération → compilation → redémarrage",
    "update.progress": "Mise à jour…",
    "update.progressStep": "Mise à jour… étape {n}/{total}{label}",
    "update.progressLabel": " ({label})",
    "update.failed": "Échec de la mise à jour",
    "update.unknownError": "Erreur inconnue",
    "update.logFileEmpty": "Fichier journal : {path}\n(vide)",

    "error.authFailed": "Strata est en cours d'exécution mais la clé API est invalide ; l'état est incomplet",

    "lang.label": "Langue",
    "field.strataDir": "Dossier Strata",
    "field.pythonPath": "Interpréteur Python",
    "field.pythonPathPlaceholder": "Vide pour utiliser le Python système (python3)",
  },

  ru: {
    appName: "Консоль Strata",

    "common.refresh": "Обновить",
    "common.copy": "Копировать",
    "common.copied": "Скопировано",
    "common.selected": "Выделено",
    "common.save": "Сохранить",
    "common.saveRestart": "Сохранить и перезапустить",
    "common.update": "Обновить",
    "common.confirm": "Подтвердить",
    "common.cancel": "Отмена",
    "common.working": "Выполняется…",

    "group.version": "Версия",
    "group.config": "Сервис",
    "group.speed": "Производительность",
    "group.resource": "Ресурсы",
    "group.logs": "Журнал",
    "group.edit": "Параметры",

    "label.model": "Модель",
    "label.uptime": "Время работы",
    "label.port": "Порт",
    "label.address": "Адрес",
    "label.apiKey": "API-ключ",
    "label.version": "Версия",
    "label.latestVersion": "Последняя",
    "label.context": "Контекст",
    "label.kv": "Квантование KV",
    "label.sessionCache": "Кэш сессии",
    "label.reasoningEffort": "Уровень рассуждений",
    "label.tg": "Ген. tg",
    "label.pp": "Prefill pp",
    "label.expertCache": "Кэш экспертов",
    "label.kvHit": "Попадания KV",

    "state.checking": "Проверка…",
    "state.running": "Работает",
    "state.starting": "Загрузка…",
    "state.stopping": "Остановка…",
    "state.restarting": "Перезапуск…",
    "state.unconfigured": "Не настроено",
    "state.notInstalled": "Не установлено",
    "state.pythonMissing": "Python недоступен",
    "state.needsConfig": "Выберите конфиг",
    "state.noConfig": "Нет конфига",
    "state.stopped": "Остановлено",

    "netMode.local": "Локально",
    "netMode.lan": "ЛВС",
    "modeBtn.local": "Локальный режим (нажмите для ЛВС)",
    "modeBtn.lan": "Режим ЛВС (нажмите для локального)",

    "action.start": "Запустить сервис",
    "action.stop": "Остановить сервис",
    "action.starting": "Запуск…",

    "version.available": "{version} доступна ⚠️",
    "version.upToDate": "✅ Актуальная версия",
    "version.checkFailed": "Проверка не удалась",
    "version.checking": "Проверка…",

    "resource.gpu": "Видеопамять",
    "resource.mem": "ОЗУ",
    "resource.gpuAria": "Использование видеопамяти",
    "resource.memAria": "Использование ОЗУ",

    "edit.startupLegend": "Запуск",
    "edit.samplingLegend": "Сэмплирование",
    "edit.sharedLegend": "Общие",
    "edit.needsRestart": "нужен перезапуск",
    "edit.takesEffect": "сразу",
    "edit.context": "Длина контекста",
    "edit.kv": "Квантование KV",
    "edit.sessionCache": "Кэш сессии (МБ)",
    "edit.maxTokens": "Макс. вывод",
    "edit.reasoningEffort": "Уровень рассуждений",
    "edit.pendingDiff": "Ожидающие изменения",
    "edit.noChange": "Изменений нет",
    "edit.noEdits": "Нечего сохранять",
    "edit.saving": "Сохранение…",
    "edit.savingRestart": "Сохранение и перезапуск…",
    "edit.saved": "Сохранено изменений: {count}{backups}{restart}",
    "edit.backups": " · резервная копия: {list}",
    "edit.restartRequired": " (нужен перезапуск)",

    "overlay.forceRefresh": "Принудительно обновить",
    "overlay.viewFullLog": "Открыть полный журнал",
    "overlay.hideLog": "Скрыть журнал",
    "overlay.timeout": "Время вышло — обновите вручную",
    "overlay.start": "Запуск сервиса…",
    "overlay.startHint": "При первом запуске около 2 минут",
    "overlay.stop": "Остановка сервиса…",
    "overlay.restart": "Перезапуск сервиса…",
    "overlay.restartHint": "Около 1–2 минут",

    "unsupported.title": "macOS не поддерживается",
    "unsupported.message": "Strata поддерживает только Windows и Linux, но не macOS.",
    "unsupported.reason": "Strata поддерживает только Windows и Linux.",
    "unsupported.projectUrl": "Проект:",

    "setup.notInstalledTitle": "Strata не найдена по пути:",
    "setup.notInstalledSub": "Проверьте путь или сначала установите Strata",
    "setup.pythonMissingHint": "Интерпретатор Python не найден",
    "setup.saveAndDetect": "Сохранить и проверить",
    "setup.savingDetect": "Сохранение и проверка…",
    "setup.saved": "Сохранено",
    "setup.needDir": "Укажите каталог Strata",
    "setup.chooseConfig": "Найдены файлы конфигурации, выберите один:",
    "setup.autoSelected": "Выбран автоматически: {file}",
    "setup.useThis": "Использовать этот конфиг",
    "setup.useSelected": "Использовать выбранный конфиг",
    "setup.selected": "Выбрано",
    "setup.noConfigTitle": "В каталоге нет файла конфигурации",
    "setup.noConfigSub": "Просканирован {dir}, strata-*.json не найден. Создайте его через setup.py или исправьте каталог в настройках Hana.",
    "setup.candidateContext": "Контекст {context}",

    "confirm.stopTitle": "Остановить сервис?",
    "confirm.stopAction": "Остановить",
    "confirm.switchModeTitle": "Смена режима сети перезапустит сервис",
    "confirm.switchModeSub": "Во время перезапуска сервис недоступен (~2 мин)",
    "confirm.restartAction": "Перезапустить",

    "update.confirmTitle": "Обновить до v{version}?",
    "update.confirmTitlePlain": "Обновить Strata?",
    "update.confirmSub": "Остановит сервис и пересоберёт (15–25 мин)",
    "update.confirmAction": "Обновить",
    "update.running": "⟳ Обновление Strata…",
    "update.steps": "Остановка → загрузка → сборка → перезапуск",
    "update.progress": "Обновление…",
    "update.progressStep": "Обновление… шаг {n}/{total}{label}",
    "update.progressLabel": " ({label})",
    "update.failed": "Обновление не удалось",
    "update.unknownError": "Неизвестная ошибка",
    "update.logFileEmpty": "Файл журнала: {path}\n(пусто)",

    "error.authFailed": "Strata запущена, но API-ключ недействителен; данные о состоянии неполные",

    "lang.label": "Язык",
    "field.strataDir": "Каталог Strata",
    "field.pythonPath": "Интерпретатор Python",
    "field.pythonPathPlaceholder": "Пусто — системный Python (python3)",
  },

  ja: {
    appName: "Strata コンソール",

    "common.refresh": "更新",
    "common.copy": "コピー",
    "common.copied": "コピーしました",
    "common.selected": "選択しました",
    "common.save": "保存",
    "common.saveRestart": "保存して再起動",
    "common.update": "更新",
    "common.confirm": "確認",
    "common.cancel": "キャンセル",
    "common.working": "処理中…",

    "group.version": "バージョン",
    "group.config": "サービス設定",
    "group.speed": "パフォーマンス",
    "group.resource": "リソース",
    "group.logs": "ログ",
    "group.edit": "パラメータ",

    "label.model": "モデル",
    "label.uptime": "稼働時間",
    "label.port": "ポート",
    "label.address": "アドレス",
    "label.apiKey": "APIキー",
    "label.version": "バージョン",
    "label.latestVersion": "最新",
    "label.context": "コンテキスト",
    "label.kv": "KV 量子化",
    "label.sessionCache": "セッションキャッシュ",
    "label.reasoningEffort": "思考レベル",
    "label.tg": "生成 tg",
    "label.pp": "Prefill pp",
    "label.expertCache": "エキスパートキャッシュ",
    "label.kvHit": "KV ヒット",

    "state.checking": "確認中…",
    "state.running": "実行中",
    "state.starting": "読み込み中…",
    "state.stopping": "停止中…",
    "state.restarting": "再起動中…",
    "state.unconfigured": "未設定",
    "state.notInstalled": "未インストール",
    "state.pythonMissing": "Python 利用不可",
    "state.needsConfig": "設定を選択",
    "state.noConfig": "設定なし",
    "state.stopped": "停止",

    "netMode.local": "ローカル",
    "netMode.lan": "LAN",
    "modeBtn.local": "ローカルモード（クリックでLANへ）",
    "modeBtn.lan": "LANモード（クリックでローカルへ）",

    "action.start": "サービスを起動",
    "action.stop": "サービスを停止",
    "action.starting": "起動中…",

    "version.available": "{version} が利用可能 ⚠️",
    "version.upToDate": "✅ 最新です",
    "version.checkFailed": "確認に失敗",
    "version.checking": "確認中…",

    "resource.gpu": "VRAM",
    "resource.mem": "メモリ",
    "resource.gpuAria": "VRAM 使用量",
    "resource.memAria": "メモリ使用量",

    "edit.startupLegend": "起動パラメータ",
    "edit.samplingLegend": "サンプリング",
    "edit.sharedLegend": "共通設定",
    "edit.needsRestart": "再起動が必要",
    "edit.takesEffect": "即時反映",
    "edit.context": "コンテキスト長",
    "edit.kv": "KV 量子化",
    "edit.sessionCache": "セッションキャッシュ (MB)",
    "edit.maxTokens": "最大出力",
    "edit.reasoningEffort": "思考レベル",
    "edit.pendingDiff": "保存待ちの変更",
    "edit.noChange": "変更なし",
    "edit.noEdits": "保存する変更がありません",
    "edit.saving": "保存中…",
    "edit.savingRestart": "保存して再起動中…",
    "edit.saved": "{count} 件の変更を保存しました{backups}{restart}",
    "edit.backups": " · バックアップ: {list}",
    "edit.restartRequired": "（再起動が必要）",

    "overlay.forceRefresh": "強制更新",
    "overlay.viewFullLog": "全文ログを表示",
    "overlay.hideLog": "ログを閉じる",
    "overlay.timeout": "タイムアウトしました。手動で更新してください",
    "overlay.start": "サービスを起動しています…",
    "overlay.startHint": "初回は約 2 分かかります",
    "overlay.stop": "サービスを停止しています…",
    "overlay.restart": "サービスを再起動しています…",
    "overlay.restartHint": "約 1〜2 分",

    "unsupported.title": "macOS 非対応",
    "unsupported.message": "Strata は Windows と Linux のみ対応で、macOS は非対応です。",
    "unsupported.reason": "Strata は Windows と Linux のみ対応です。",
    "unsupported.projectUrl": "プロジェクト：",

    "setup.notInstalledTitle": "次の場所に Strata が見つかりません：",
    "setup.notInstalledSub": "パスを確認するか、先に Strata をインストールしてください",
    "setup.pythonMissingHint": "Python インタプリタが見つかりません",
    "setup.saveAndDetect": "保存して検出",
    "setup.savingDetect": "保存して検出中…",
    "setup.saved": "保存しました",
    "setup.needDir": "Strata ディレクトリを入力してください",
    "setup.chooseConfig": "設定ファイルが見つかりました。1つ選択してください：",
    "setup.autoSelected": "自動選択：{file}",
    "setup.useThis": "この設定を使用",
    "setup.useSelected": "選択した設定を使用",
    "setup.selected": "選択しました",
    "setup.noConfigTitle": "ディレクトリに設定ファイルがありません",
    "setup.noConfigSub": "{dir} をスキャンしましたが strata-*.json が見つかりません。setup.py で生成するか、Hana 設定でディレクトリを修正してください。",
    "setup.candidateContext": "コンテキスト {context}",

    "confirm.stopTitle": "サービスを停止しますか？",
    "confirm.stopAction": "停止",
    "confirm.switchModeTitle": "ネットワークモードの切り替えは再起動します",
    "confirm.switchModeSub": "再起動中はサービスを利用できません（約 2 分）",
    "confirm.restartAction": "再起動",

    "update.confirmTitle": "v{version} に更新しますか？",
    "update.confirmTitlePlain": "Strata を更新しますか？",
    "update.confirmSub": "サービスを停止して再ビルドします（15〜25 分）",
    "update.confirmAction": "更新する",
    "update.running": "⟳ Strata を更新中…",
    "update.steps": "停止 → 取得 → ビルド → 再起動",
    "update.progress": "更新中…",
    "update.progressStep": "更新中… {n}/{total} ステップ{label}",
    "update.progressLabel": "（{label}）",
    "update.failed": "更新に失敗",
    "update.unknownError": "不明なエラー",
    "update.logFileEmpty": "ログファイル：{path}\n（内容なし）",

    "error.authFailed": "Strata は動作中ですが API キーが無効です。状態情報が不完全です",

    "lang.label": "言語",
    "field.strataDir": "Strata ディレクトリ",
    "field.pythonPath": "Python インタプリタ",
    "field.pythonPathPlaceholder": "空欄ならシステム Python（python3）を使用",
  },

  ko: {
    appName: "Strata 콘솔",

    "common.refresh": "새로 고침",
    "common.copy": "복사",
    "common.copied": "복사됨",
    "common.selected": "선택됨",
    "common.save": "저장",
    "common.saveRestart": "저장 후 재시작",
    "common.update": "업데이트",
    "common.confirm": "확인",
    "common.cancel": "취소",
    "common.working": "처리 중…",

    "group.version": "버전",
    "group.config": "서비스 설정",
    "group.speed": "성능",
    "group.resource": "리소스",
    "group.logs": "로그",
    "group.edit": "매개변수",

    "label.model": "모델",
    "label.uptime": "가동 시간",
    "label.port": "포트",
    "label.address": "주소",
    "label.apiKey": "API 키",
    "label.version": "버전",
    "label.latestVersion": "최신",
    "label.context": "컨텍스트",
    "label.kv": "KV 양자화",
    "label.sessionCache": "세션 캐시",
    "label.reasoningEffort": "사고 수준",
    "label.tg": "생성 tg",
    "label.pp": "Prefill pp",
    "label.expertCache": "전문가 캐시",
    "label.kvHit": "KV 적중",

    "state.checking": "확인 중…",
    "state.running": "실행 중",
    "state.starting": "로딩 중…",
    "state.stopping": "중지 중…",
    "state.restarting": "재시작 중…",
    "state.unconfigured": "미설정",
    "state.notInstalled": "미설치",
    "state.pythonMissing": "Python 사용 불가",
    "state.needsConfig": "설정 선택 필요",
    "state.noConfig": "설정 없음",
    "state.stopped": "중지됨",

    "netMode.local": "로컬",
    "netMode.lan": "LAN",
    "modeBtn.local": "로컬 모드 (클릭하여 LAN으로 전환)",
    "modeBtn.lan": "LAN 모드 (클릭하여 로컬로 전환)",

    "action.start": "서비스 시작",
    "action.stop": "서비스 중지",
    "action.starting": "시작 중…",

    "version.available": "{version} 사용 가능 ⚠️",
    "version.upToDate": "✅ 최신 버전",
    "version.checkFailed": "확인 실패",
    "version.checking": "확인 중…",

    "resource.gpu": "VRAM",
    "resource.mem": "메모리",
    "resource.gpuAria": "VRAM 사용량",
    "resource.memAria": "메모리 사용량",

    "edit.startupLegend": "시작 매개변수",
    "edit.samplingLegend": "샘플링",
    "edit.sharedLegend": "공통 설정",
    "edit.needsRestart": "재시작 필요",
    "edit.takesEffect": "즉시 적용",
    "edit.context": "컨텍스트 길이",
    "edit.kv": "KV 양자화",
    "edit.sessionCache": "세션 캐시 (MB)",
    "edit.maxTokens": "최대 출력",
    "edit.reasoningEffort": "사고 수준",
    "edit.pendingDiff": "저장 대기 변경",
    "edit.noChange": "변경 사항 없음",
    "edit.noEdits": "저장할 변경 사항이 없습니다",
    "edit.saving": "저장 중…",
    "edit.savingRestart": "저장 후 재시작 중…",
    "edit.saved": "변경 {count}건 저장됨{backups}{restart}",
    "edit.backups": " · 백업: {list}",
    "edit.restartRequired": " (재시작 필요)",

    "overlay.forceRefresh": "강제 새로 고침",
    "overlay.viewFullLog": "전체 로그 보기",
    "overlay.hideLog": "로그 접기",
    "overlay.timeout": "시간 초과 — 수동으로 새로 고침하세요",
    "overlay.start": "서비스를 시작하는 중…",
    "overlay.startHint": "첫 시작은 약 2분 소요",
    "overlay.stop": "서비스를 중지하는 중…",
    "overlay.restart": "서비스를 재시작하는 중…",
    "overlay.restartHint": "약 1~2분",

    "unsupported.title": "macOS 미지원",
    "unsupported.message": "Strata는 Windows와 Linux만 지원하며 macOS는 지원하지 않습니다.",
    "unsupported.reason": "Strata는 Windows와 Linux만 지원합니다.",
    "unsupported.projectUrl": "프로젝트:",

    "setup.notInstalledTitle": "다음 경로에서 Strata를 찾을 수 없습니다:",
    "setup.notInstalledSub": "경로를 확인하거나 먼저 Strata를 설치하세요",
    "setup.pythonMissingHint": "Python 인터프리터를 찾을 수 없습니다",
    "setup.saveAndDetect": "저장 후 감지",
    "setup.savingDetect": "저장하고 감지 중…",
    "setup.saved": "저장됨",
    "setup.needDir": "Strata 디렉터리를 입력하세요",
    "setup.chooseConfig": "설정 파일을 찾았습니다. 하나를 선택하세요:",
    "setup.autoSelected": "자동 선택됨: {file}",
    "setup.useThis": "이 설정 사용",
    "setup.useSelected": "선택한 설정 사용",
    "setup.selected": "선택됨",
    "setup.noConfigTitle": "디렉터리에 설정 파일이 없습니다",
    "setup.noConfigSub": "{dir}을(를) 검사했지만 strata-*.json이 없습니다. setup.py로 생성하거나 Hana 설정에서 디렉터리를 수정하세요.",
    "setup.candidateContext": "컨텍스트 {context}",

    "confirm.stopTitle": "서비스를 중지할까요?",
    "confirm.stopAction": "중지",
    "confirm.switchModeTitle": "네트워크 모드 전환은 재시작됩니다",
    "confirm.switchModeSub": "재시작 중에는 서비스를 사용할 수 없습니다 (약 2분)",
    "confirm.restartAction": "재시작",

    "update.confirmTitle": "v{version}(으)로 업데이트할까요?",
    "update.confirmTitlePlain": "Strata를 업데이트할까요?",
    "update.confirmSub": "서비스를 중지하고 다시 빌드합니다 (15~25분)",
    "update.confirmAction": "업데이트",
    "update.running": "⟳ Strata 업데이트 중…",
    "update.steps": "중지 → 가져오기 → 빌드 → 재시작",
    "update.progress": "업데이트 중…",
    "update.progressStep": "업데이트 중… {n}/{total} 단계{label}",
    "update.progressLabel": " ({label})",
    "update.failed": "업데이트 실패",
    "update.unknownError": "알 수 없는 오류",
    "update.logFileEmpty": "로그 파일: {path}\n(내용 없음)",

    "error.authFailed": "Strata는 실행 중이지만 API 키가 유효하지 않아 상태 정보가 불완전합니다",

    "lang.label": "언어",
    "field.strataDir": "Strata 디렉터리",
    "field.pythonPath": "Python 인터프리터",
    "field.pythonPathPlaceholder": "비워 두면 시스템 Python (python3) 사용",
  },
};

const STORAGE_KEY = "hanako-localstrata.lang";

let current = null;

/** Pick the closest supported locale from navigator.language(s); fall back to en. */
export function detectLang() {
  const candidates = [];
  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
  }
  for (const c of candidates) {
    const base = String(c || "").toLowerCase().split("-")[0];
    if (LANGS.includes(base)) return base;
  }
  return "en";
}

/** Restore an explicit user choice if one was saved, else auto-detect. */
export function loadLang() {
  try {
    const saved = window.localStorage?.getItem(STORAGE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* storage may be unavailable in some sandboxed iframes */
  }
  return detectLang();
}

export function saveLang(lang) {
  try {
    window.localStorage?.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
}

export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : "en";
  return current;
}

export function getLang() {
  return current || "en";
}

/** Translate one key. Unknown keys fall back to en, then to the key itself. */
export function t(key, lang) {
  const l = lang || getLang();
  const table = STRINGS[l] || STRINGS.en;
  const value = table[key];
  if (value !== undefined) return value;
  const fallback = STRINGS.en[key];
  return fallback !== undefined ? fallback : key;
}

/** Translate then substitute {name} placeholders. */
export function tp(key, params = {}, lang) {
  let out = t(key, lang);
  for (const [name, value] of Object.entries(params)) {
    out = out.split(`{${name}}`).join(value === undefined || value === null ? "" : String(value));
  }
  return out;
}

/**
 * Translate every [data-i18n] / [data-i18n-title] / [data-i18n-aria-label] /
 * [data-i18n-placeholder] node under `root`. Safe to call repeatedly; pass a
 * <template>.content to localize not-yet-cloned markup.
 */
export function applyI18n(root) {
  const scope = root || (typeof document !== "undefined" ? document : null);
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  for (const el of scope.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of scope.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of scope.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
  for (const el of scope.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = getLang();
    document.title = t("appName");
  }
}
