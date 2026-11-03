# 学习资料示例（全部虚构）

这里的文件是**脱敏示例**，用来演示 `docs/PERSONA.md` 里说的一套写法。群名、群号、群友昵称、聊天内容都是编的。

| 文件 | 对应真实位置 | 作用 |
| --- | --- | --- |
| `group-background.example.md` | 控制台「二代仿真 → 初始提示词」 | 这个群是什么地方、氛围、忌讳。**只在会话第一次唤醒时注入一次** |
| `study-notebook-group.example.md` | `state/learning/学习本/group-<群号>.md` | 这个群的人、梗、正在追的事 |
| `study-notebook-global.example.md` | `state/learning/global.md` | 跨群通用的事实、关于自己的心态 |
| `human-feel.example.md` | 人格卡的「怎么说话」小节素材 | 从真实聊天里提炼的语气特征 |
| `situation.example.md` | `state/situation.md` | 「主人是谁、我在哪几个场子」的脱敏摘要 |

## 为什么示例里没有真实数据

真实的群号、群友 QQ 号、聊天原文属于**第三方**——群友没有同意把自己的话交给一个公开仓库。所以：

- 群号统一用 `100000001`
- 昵称用「阿岚」「小七」「老白」
- 聊天内容是按真实语气重写的，不是拷贝

你 fork 之后，把这些文件填成自己的内容即可，`state/` 本来就不入库。
