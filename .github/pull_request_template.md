name: Pull Request

about: 提交改动前请过一遍这个清单

---

## 这个 PR 做了什么

<!-- 一两句话说清楚。修 bug 请说明「改之前是什么现象」 -->

## 类型

- [ ] 修 bug
- [ ] 新功能
- [ ] 重构（行为不变）
- [ ] 文档
- [ ] 测试 / CI
- [ ] 安全相关

## 怎么验证的

<!-- 跑了哪些命令 / 手工怎么试的。贴输出片段，不要贴未脱敏日志 -->

```bash
npm run test:audit
npm run privacy-scan
npm run check:docs
```

## 检查单

- [ ] `npm run test:audit` 没有**新增**失败（当前基线 30/35，见 KNOWN_ISSUES.md）
- [ ] `npm run privacy-scan` 通过
- [ ] `npm run check:docs` 通过
- [ ] 新增/修改的行为有回归测试
- [ ] 没有提交 `config.json` / `state/` / `audio/` / `*.bak-*`
- [ ] 日志、截图、测试夹具里的个人信息已脱敏
- [ ] 改了目录结构 → 同步 `docs/FOLDER_MAP.md`
- [ ] 改了配置项 → 同步 `config.example.json`
- [ ] 改了 `dsh/agent-presets/**` → 跑过 `node scripts/build-agent-preset-patches.mjs`

## 如果是修 bug

- 是**测试滞后**还是**代码 bug**？判断依据是什么？
- 有没有加一条能钉住这次修复的反面断言？

## 如果是改安全边界

<!-- 动了白名单、工具面、safe-fetch、路径校验的话，请说明威胁模型上变了什么 -->

## 关联 issue

Closes #
