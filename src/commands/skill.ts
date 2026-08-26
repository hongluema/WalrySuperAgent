import { type ModelMessage } from 'ai';
import { agentLoop } from '../agent/loop.js';
import type { CommandHandler } from './index.js';
import type { SkillLoader } from '../skills/loader.js';

export function createSkillCommands(skillLoader: SkillLoader, activeSkills: Set<string>): CommandHandler[] {
  return [
    // /skill list
    (cmd, ctx) => {
      if (cmd !== '/skill' && cmd !== '/skill list' && cmd !== 'skill list') return false;
      const skills = skillLoader.list();
      if (skills.length === 0) {
        console.log('\n[skills] 没有找到任何 skill。在 .skills/ 目录下创建 skill-name/SKILL.md 即可。\n');
        return true;
      }
      console.log(`\n[skills] 共 ${skills.length} 个可用：`);
      for (const s of skills) {
        const active = s.alwaysOn
          ? ' ✓ 始终启用'
          : activeSkills.has(s.name) ? ' ✓ 已激活' : '';
        console.log(`  /${s.name} — ${s.description}${active}`);
        if (s.whenToUse) console.log(`    适用场景: ${s.whenToUse}`);
      }
      console.log('');
      return true;
    },

    // /skill load <name>
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      const skill = skillLoader.get(name);
      if (!skill) {
        console.log(`\n[skills] 找不到 skill: ${name}\n`);
        return true;
      }
      if (skill.alwaysOn) {
        console.log(`\n[skills] ${name} 是始终启用的教学法，无需手动激活\n`);
        return true;
      }
      activeSkills.add(name);
      console.log(`\n[skills] 已激活: ${name} — ${skill.description}\n`);
      return true;
    },

    // /skill unload <name>
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      const skill = skillLoader.get(name);
      if (skill?.alwaysOn) {
        console.log(`\n[skills] ${name} 是始终启用的教学法，不能卸载\n`);
        return true;
      }
      if (!activeSkills.has(name)) {
        console.log(`\n[skills] ${name} 未激活\n`);
        return true;
      }
      activeSkills.delete(name);
      console.log(`\n[skills] 已卸载: ${name}\n`);
      return true;
    },

    // /<skill-name> — 直接用 /code-review 激活并触发
    (cmd, ctx) => {
      if (!cmd.startsWith('/')) return false;
      const parts = cmd.slice(1).split(/\s+/);
      const name = parts[0];
      const skill = skillLoader.get(name);
      if (!skill) return false;

      const args = parts.slice(1).join(' ');

      if (skill.alwaysOn) {
        const content = args
          ? `开始教学。主题：${args}`
          : '开始教学。先问我今天想学什么。';
        console.log(`\n[tutor] 进入教学：${args || '待确认主题'}\n`);

        const userMsg: ModelMessage = { role: 'user', content };
        ctx.messages.push(userMsg);
        ctx.timestamps.set(ctx.messages.length - 1, Date.now());
        ctx.sessionStore.append(userMsg);

        const currentSystem = ctx.builder.build(ctx.makePromptCtx());
        const beforeLen = ctx.messages.length;

        agentLoop(ctx.model, ctx.registry, ctx.messages, currentSystem, ctx.tracker).then(() => {
          const newMessages = ctx.messages.slice(beforeLen);
          const now = Date.now();
          for (let i = beforeLen; i < ctx.messages.length; i++) ctx.timestamps.set(i, now);
          ctx.sessionStore.appendAll(newMessages);
          ctx.ask();
        });

        return 'async';
      }

      activeSkills.add(name);
      console.log(`\n[skills] 激活 ${name}，开始执行...`);

      const content = args
        ? `${skill.content}\n\n用户指令: ${args}`
        : skill.content;

      const userMsg: ModelMessage = { role: 'user', content };
      ctx.messages.push(userMsg);
      ctx.timestamps.set(ctx.messages.length - 1, Date.now());
      ctx.sessionStore.append(userMsg);

      const currentSystem = ctx.builder.build(ctx.makePromptCtx());
      const beforeLen = ctx.messages.length;

      agentLoop(ctx.model, ctx.registry, ctx.messages, currentSystem, ctx.tracker).then(() => {
        const newMessages = ctx.messages.slice(beforeLen);
        const now = Date.now();
        for (let i = beforeLen; i < ctx.messages.length; i++) ctx.timestamps.set(i, now);
        ctx.sessionStore.appendAll(newMessages);
        ctx.ask();
      });

      return 'async';
    },
  ];
}
