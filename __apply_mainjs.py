import re

TARGET = 'C:/Users/Abuzer Kakar/Desktop/autodash-control-panel/main.js'
LOG = 'C:/Users/Abuzer Kakar/Desktop/autodash-control-panel/__mainjs_diff.log'

with open(TARGET, 'r', encoding='utf-8') as f:
    c = f.read()

orig_len = len(c)
hits = []

BS = chr(92)   # single backslash
SQ = chr(39)   # single quote
DQ = chr(34)   # double quote
CR = chr(13)   # carriage return
NL = chr(10)   # newline

def apply(name, pattern, repl, min_delta):
    global c
    before = len(c)
    c = re.sub(pattern, repl, c)
    after = len(c)
    delta = after - before
    ok = delta >= min_delta
    hits.append((name, before, after, delta, min_delta, ok))
    print(('OK' if ok else 'WARN') + ': ' + name + ' delta=' + str(delta) + ' min=' + str(min_delta) + ' OK=' + str(ok))

# ---- Diff 1a: skipTaskbar: false ----
# pattern: CRLF + 8 spaces + autoHideMenuBar: true + CRLF
pat1a = CR + NL + '        ' + 'autoHideMenuBar: true' + CR + NL
repl1a = CR + NL + r'\1' + 'autoHideMenuBar: true,' + CR + NL + r'\1' + 'skipTaskbar: false,   // ensure the window always has a taskbar entry' + CR + NL
apply('Diff1a-skipTaskbar', pat1a, repl1a, 30)

# ---- Diff 1b: one-time minimize balloon ----
# pattern: CRLF + 12 spaces + mainWindow.hide(); + CRLF + 8 spaces + } + CRLF
pat1b = CR + NL + '            ' + 'mainWindow.hide();' + CR + NL + '        ' + '}' + CR + NL
repl1b = (CR + NL + r'\1' + 'mainWindow.hide();' + CR + NL +
          r'\1' + 'if (!mainWindow._minimizeBalloonFired) {' + CR + NL +
          r'\1' + '    mainWindow._minimizeBalloonFired = true;' + CR + NL +
          r'\1' + '    if (tray) tray.displayBalloon({ title: ' + DQ + 'AutoDash running in background' + DQ + ', content: ' + DQ + 'Click the tray icon to reopen.' + DQ + ' });' + CR + NL +
          r'\1' + '}' + CR + NL + r'\2' + '}' + CR + NL)
apply('Diff1b-minimize-balloon', pat1b, repl1b, 120)

# ---- Diff 3: context menu Show Dashboard ----
apply('Diff3-contextmenu',
      'if (mainWindow) mainWindow' + BS + '.show()' + BS + ' }',
      'if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }',
      60)

# ---- Diff 2: tray restoreTrayWindow ----
# pattern: CRLF + 4 spaces + tray.on(SQ + double-click + SQ, () => { if (mainWindow) mainWindow.show(); });
#          + CRLF + 4 spaces + // Left-click ... comment
#          + CRLF + 4 spaces + tray.on(SQ + click + SQ, () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); }; });
pat2 = (CR + NL + '    ' + 'tray.on(' + SQ + 'double-click' + SQ + ', () => { if (mainWindow) mainWindow' + BS + '.show()' + BS + ');' + CR + NL +
        '    ' + '// Left-click on the tray icon also shows the dashboard' + CR + NL +
        '    ' + 'tray.on(' + SQ + 'click' + SQ + ', () => { if (mainWindow) { mainWindow' + BS + '.show()' + BS + ' ' + 'mainWindow' + BS + '.focus()' + BS + '; }); ' + BS + '}' + ';' + CR + NL)
repl2 = (CR + NL + r'\1' + 'function restoreTrayWindow() {' + CR + NL +
         r'\1' + '    if (!mainWindow) return;' + CR + NL +
         r'\1' + '    if (mainWindow.isMinimized()) mainWindow.restore();' + CR + NL +
         r'\1' + '    mainWindow.show();' + CR + NL +
         r'\1' + '    mainWindow.focus();' + CR + NL +
         r'\1' + '}' + CR + NL +
         r'\1' + 'tray.on(' + SQ + 'double-click' + SQ + ', restoreTrayWindow);' + CR + NL +
         r'\1' + 'tray.on(' + SQ + 'click' + SQ + ', restoreTrayWindow);' + CR + NL)
apply('Diff2-tray-restore', pat2, repl2, 120)

# ---- Diff 4: single-instance lock before app.whenReady() ----
pat4 = CR + NL + '        ' + 'app' + BS + '.whenReady()' + BS + '.then(() => {' + CR + NL
repl4 = (CR + NL +
         '// ==========================================' + CR + NL +
         r'\1' + '// Single-instance lock: focus existing window on second launch.' + CR + NL +
         '// ==========================================' + CR + NL +
         r'\1' + 'const gotLock = app.requestSingleInstanceLock();' + CR + NL +
         r'\1' + 'if (!gotLock) { app.quit(); }' + CR + NL +
         r'\1' + 'else {' + CR + NL +
         r'\1' + '    app.on(' + SQ + 'second-instance' + SQ + ', () => {' + CR + NL +
         r'\1' + '        if (mainWindow) {' + CR + NL +
         r'\1' + '            if (mainWindow.isMinimized()) mainWindow.restore();' + CR + NL +
         r'\1' + '            mainWindow.show();' + CR + NL +
         r'\1' + '            mainWindow.focus();' + CR + NL +
         r'\1' + '        }' + CR + NL +
         r'\1' + '    });' + CR + NL +
         r'\1' + '}' + CR + NL +
         r'\1' + '' + CR + NL +
         r'\1' + 'app.whenReady().then(() =>{')
apply('Diff4-single-instance', pat4, repl4, 250)

with open(TARGET, 'w', encoding='utf-8') as f:
    f.write(c)

new_len = len(c)
delta_pct = round((new_len - orig_len) / orig_len * 10000) / 100
line_count = len(c.splitlines())

with open(LOG, 'w', encoding='utf-8') as f:
    f.write('NAME,BEFORE,AFTER,DELTA,MIN_EXPECTED,OK\n')
    for h in hits:
        f.write(','.join(str(x) for x in h) + '\n')

print('FILE: ' + TARGET)
print('ORIG_LEN: ' + str(orig_len) + '  NEW_LEN: ' + str(new_len) + '  DELTA:' + str(delta_pct) + '%')
print('LINE_COUNT: ' + str(line_count))
print('LOG: ' + LOG)
print('HITS:')
for h in hits:
    print('  ' + h[0] + ': delta=' + str(h[3]) + ' min=' + str(h[4]) + ' OK=' + str(h[5]))
