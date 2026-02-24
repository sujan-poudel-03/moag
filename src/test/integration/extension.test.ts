// ─── Integration tests — run inside VS Code Extension Host ───

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Integration Tests', () => {
  test('Extension should be present in installed extensions', () => {
    const ext = vscode.extensions.getExtension('moag.agent-task-player');
    assert.ok(ext, 'Extension not found. Is the publisher "moag" and name "agent-task-player"?');
  });

  test('Extension should activate without error', async () => {
    const ext = vscode.extensions.getExtension('moag.agent-task-player');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext?.isActive, 'Extension failed to activate');
  });

  test('All 23 commands should be registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      'agentTaskPlayer.play',
      'agentTaskPlayer.pause',
      'agentTaskPlayer.stop',
      'agentTaskPlayer.openPlan',
      'agentTaskPlayer.newPlan',
      'agentTaskPlayer.addPlaylist',
      'agentTaskPlayer.addTask',
      'agentTaskPlayer.editTask',
      'agentTaskPlayer.deleteItem',
      'agentTaskPlayer.moveUp',
      'agentTaskPlayer.moveDown',
      'agentTaskPlayer.showHistory',
      'agentTaskPlayer.showDashboard',
      'agentTaskPlayer.clearHistory',
      'agentTaskPlayer.playPlaylist',
      'agentTaskPlayer.playTask',
      'agentTaskPlayer.addTaskFromTemplate',
      'agentTaskPlayer.saveTaskAsTemplate',
      'agentTaskPlayer.exportPlan',
      'agentTaskPlayer.importPlan',
      'agentTaskPlayer.showCostSummary',
      'agentTaskPlayer.gettingStarted',
      'agentTaskPlayer.detectEngines',
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        allCommands.includes(cmd),
        `Command "${cmd}" not registered`,
      );
    }
  });
});
