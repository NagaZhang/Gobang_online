'use strict';

// 五子棋纯逻辑模块，供服务端做权威判定
const SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

function createBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

function isInside(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

// 在 (x,y) 落子；非法（越界/已有子）返回 false
function placeStone(board, x, y, color) {
  if (!isInside(x, y) || board[y][x] !== EMPTY) return false;
  board[y][x] = color;
  return true;
}

// 判定最后落在 (x,y) 的 color 方是否形成五连（含五连以上），返回连成线的坐标或 null
function getWinLine(board, x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const points = [[x, y]];
    for (let s = 1; s < SIZE; s++) {
      const nx = x + dx * s;
      const ny = y + dy * s;
      if (isInside(nx, ny) && board[ny][nx] === color) points.push([nx, ny]);
      else break;
    }
    for (let s = 1; s < SIZE; s++) {
      const nx = x - dx * s;
      const ny = y - dy * s;
      if (isInside(nx, ny) && board[ny][nx] === color) points.push([nx, ny]);
      else break;
    }
    if (points.length >= 5) return points;
  }
  return null;
}

function isBoardFull(board) {
  return board.every((row) => row.every((cell) => cell !== EMPTY));
}

module.exports = {
  SIZE,
  EMPTY,
  BLACK,
  WHITE,
  createBoard,
  isInside,
  placeStone,
  getWinLine,
  isBoardFull,
};
