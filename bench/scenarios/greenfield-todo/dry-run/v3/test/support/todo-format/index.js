'use strict';

function formatTodo(todo) {
  return `${todo.id} [${todo.done ? 'x' : ' '}] ${todo.text}`;
}

module.exports = { formatTodo };
