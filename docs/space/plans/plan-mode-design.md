方案模式由以下几个条件触发：

  1. 用户主动进入例如在提示词输入框直接输入 /plan 后面跟随提示词
  2. 用户提示词代码出方案这类明显得提示词，agent自主判断进入方案模式
  3. 类似Claude Code，通过shift + tab 切换到方案模式
  
接下来，方案模式下的操作流程如下：

    1. 当方案模式被触发后，agent在进入方案模式前会自主思考，如果agent在思考过程中发现用户的提示词不够明确，agent会主动向用户提问以获取更多信息，从而更好地理解用户的需求。

        进入方案模式前，对于疑问点向用户确认

        ←  ☒ 修订后行为  ☐ 补充方式  ☐ 触发时机  ✔ Submit  →

        补充方案时，用户输入应该是纯自由文本，还是应该提供结构化的补充选项（如：补充某个步骤 / 
        修改整体方向 / 添加约束条件）？

        ❯ 1. 纯自由文本 (Recommended)
            一个文本输入框，用户自由输入。简单直接，模型能理解自然语言。与 InputBlock 的 free-text 
            模式一致，复用现有代码。
        2. 结构化选项 + 自由文本
            先选补充类别（步骤/方向/约束），再输入文本。更结构化但增加交互复杂度，且类别划分可能不准
            确。
        3. Type something.
        
        agent会给出补充方案的建议，用户可以选择接受或修改。选项3是用户可以直接输入文本，agent会根据用户的输入进行理解和处理。


        向用户确认完毕后，进行提交：

        ←  ☒ 修订后行为  ☒ 补充方式  ☒ 触发时机  ✔ Submit  →

        Review your answers

        ● 方案磋商循环中，supplement 后 agent 修订方案再次提交，应该再次触发 plan_review
        中断让用户审查，还是 agent 修订后直接执行？
        → 再次中断审查 (Recommended)
        ● 补充方案时，用户输入应该是纯自由文本，还是应该提供结构化的补充选项（如：补充某个步骤 /
        修改整体方向 / 添加约束条件）？
        → 纯自由文本 (Recommended)
        ● 首次 update_plan 的触发时机：是让 agent
        自己判断何时该先出方案（当前行为），还是加一个更强的约束让 agent 在复杂任务中必须先规划？
        → 保持 agent 自主判断 (Recommended)

        Ready to submit your answers?

        ❯ 1. Submit answers
        4. Cancel

        如果选择Cancel，则回到方案模式前的状态，用户可以继续输入提示词或进行其他操作。

    2. 方案模式被触发后，agent会根据用户的提示词生成一个初步的方案，并将其展示给用户。用户可以对方案进行审查，并提出修改意见或补充信息。

        Plan: 优化 TUI 文件变更渲染 — 统一 diff 格式

        Context: 当前 TUI 文件变更渲染存在多个格式，导致维护复杂度高。目标是统一 diff 格式，简化维护。

        Step1: 分析现有渲染格式，评估差异和维护成本。
        Step2: 设计统一的 diff 格式，确保兼容现有功能。
        Step3: 实施新的 diff 格式，并进行测试验证。

        测试验证: 
        1. 单元测试：覆盖所有 diff 格式相关的功能，确保新格式正确渲染。
        2. 性能测试：评估新格式对渲染性能的影响，确保没有显著下降。
        ...
        ─────────────────────────────────────────────────────────────────────────────────────────────────────
        Claude has written up a plan and is ready to execute. Would you like to proceed?

        > 1. Yes, and use auto mode
        2. Yes, manually approve edits
        3. Tell Agent what to change


        选择“Yes, and use auto mode”后，agent会直接执行方案中的步骤，并在执行过程中自动处理任何需要修改的部分，无需用户干预。
        选择“Yes, manually approve edits”后，agent会在执行每个步骤前向用户展示即将进行的修改，并等待用户的批准后才继续执行下一步。
        选择“Tell Agent what to change”后，用户可以直接输入文本直接告诉agent需要修改的部分，agent会根据用户的指示进行调整并重新生成方案。

