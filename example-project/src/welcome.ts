/**
 * A little space for your next big idea.
 * Welcome to Nexus. Your code stays with you.
 */

type Workspace = {
  name: string;
  location: 'local';
  possibilities: 'unlimited';
};

export function createWorkspace(name: string): Workspace {
  return {
    name,
    location: 'local',
    possibilities: 'unlimited',
  };
}

const workspace = createWorkspace('Something great');

console.log(`Hello, ${workspace.name}.`);

// Make yourself at home.
// 1. Open your project with ⌘O.
// 2. Add a GGUF model from your computer.
// 3. Start a conversation in the assistant panel.
