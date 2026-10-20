// dsh-heart 的客户端半边：设置页里的「心」面板。
// 不打包、不依赖构建：浏览器侧用 ModuleLoader 的工厂格式，React 从宿主 require。
window.__ModuleLoader__.load({
  id: '@dsh/heart',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const chip = {
      display: 'inline-block',
      padding: '2px 8px',
      marginRight: 6,
      borderRadius: 999,
      background: 'var(--dsh-surface-2, rgba(127,127,127,.12))',
      fontSize: 12,
    }
    const row = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 13 }
    const btn = {
      padding: '6px 12px',
      marginRight: 8,
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
      background: 'transparent',
      cursor: 'pointer',
      fontSize: 13,
    }

    function Panel() {
      const [data, setData] = React.useState(null)
      const [note, setNote] = React.useState('')

      const load = React.useCallback(() => {
        fetch('/dsh-heart/state')
          .then((r) => r.json())
          .then(setData)
          .catch(() => setNote('读不到状态（宿主没起 webServer？）'))
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [load])

      const act = (url, label) => {
        setNote(label + '…')
        fetch(url, { method: 'POST' })
          .then((r) => r.json())
          .then((v) => {
            setNote(label + '：' + JSON.stringify(v).slice(0, 160))
            load()
          })
          .catch((e) => setNote(label + '失败：' + e.message))
      }

      if (!data) {
        return h('div', { style: { padding: 12, fontSize: 13 } }, note || '加载中…')
      }

      return h(
        'div',
        { style: { padding: '4px 2px 16px' } },
        h('div', { style: row }, h('span', { style: chip }, '身体：' + data.body)),
        h('div', { style: row }, h('span', { style: chip }, '本子 ' + data.notebookEntries)),
        h('div', { style: row }, h('span', { style: chip }, '事实 ' + data.factEntries)),
        h('div', { style: row }, h('span', { style: chip }, '情节 ' + data.memoryEntries)),
        h('div', { style: row }, h('span', { style: chip }, '器官 ' + (data.organs || []).join(' / '))),
        h(
          'div',
          { style: row },
          h('span', { style: chip }, data.config && data.config.pulse ? '节律开 · ' + data.config.pulseSeconds + 's' : '节律关')
        ),
        h(
          'div',
          { style: { margin: '10px 0' } },
          h('button', { style: btn, onClick: () => act('/dsh-heart/tick', '叫它醒一次') }, '现在醒一次'),
          h('button', { style: btn, onClick: () => act('/dsh-heart/export', '导出') }, '导出备份'),
          h('button', { style: btn, onClick: load }, '刷新')
        ),
        note ? h('div', { style: { fontSize: 12, opacity: 0.7, margin: '4px 0 8px' } }, note) : null,
        h('div', { style: { fontSize: 12, opacity: 0.6, margin: '10px 0 4px' } }, '时间线'),
        h(
          'div',
          {
            style: {
              fontFamily: 'ui-monospace, monospace',
              fontSize: 12,
              lineHeight: 1.7,
              maxHeight: 220,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            },
          },
          (data.pulse && data.pulse.length ? data.pulse.slice().reverse().join('\n') : '（还没有醒过）')
        )
      )
    }

    exports.inject = ['timer']
    exports.apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'dsh-heart', order: 32, label: () => '心' },
          () => h(Panel)
        )
      )
    }

    return module.exports
  },
})
