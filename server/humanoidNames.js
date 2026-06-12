/** Random display names for lobby fill players. */
export const HUMANOID_NAMES = [
  'Alex', 'Nova', 'Zara', 'Kai', 'Luna', 'Aiden', 'Nexus', 'Aria', 'Zayn', 'Milo',
  'Orion', 'Ava', 'Rex', 'Echo', 'Leo', 'Atlas', 'Maya', 'Axel', 'Juno', 'Finn',
  'Vega', 'Nina', 'Ryker', 'Skye', 'Jett', 'Pixel', 'Iris', 'Blaze', 'Sage', 'Neo',
  'Cora', 'Titan', 'Lyra', 'Ace', 'Raven', 'Koda', 'Nyx', 'Zephyr', 'Cosmo', 'Bolt',
  'Cipher', 'Vector', 'Unit-7', 'XR-12', 'NovaBot', 'Alpha-X', 'Omega-9', 'Byte', 'Circuit', 'Logic',
  'Mecha', 'Astro', 'RoboMax', 'Data', 'Core', 'Flux', 'Matrix', 'Synth', 'Quantum', 'Nano',
  'Proto', 'Cyber', 'Titanium', 'Apollo', 'Helix', 'Orbit', 'Vertex', 'Pulse', 'Chrome', 'Vortex',
  'Binary', 'Axiom', 'Zenith', 'Neon', 'Falcon', 'Phoenix', 'Drift', 'Shadow', 'Ghost', 'Storm',
  'Rocket', 'Comet', 'Maverick', 'Hunter', 'Wolf', 'Blade', 'Thunder', 'Frost', 'Ember', 'Flare',
  'Onyx', 'Steel', 'Brick', 'Rocketson', 'Adam', 'Omar', 'Ali', 'Yusuf', 'Ibrahim', 'Ismail',
  'Musa', 'Harun', 'Bilal', 'Hamza', 'Zaid', 'Khalid', 'Tariq', 'Ammar', 'Anas', 'Hassan',
  'Hussein', 'Mustafa', 'Salman', 'Nabil', 'Rayan', 'Ayaan', 'Rayyan', 'Saif', 'Jamal', 'Karim',
  'Faris', 'Samir', 'Zahir', 'Malik', 'Noor', 'Amina', 'Fatima', 'Maryam', 'Layla', 'Sara',
  'Yasmin', 'Zainab', 'Huda', 'Nadia', 'Aaliyah', 'Khadija', 'Mariam', 'Salma', 'Rania', 'Amira',
  'Lina', 'Aya', 'Reem', 'Dana', 'Jana', 'Nour', 'Eman', 'Samar', 'Abeer', 'Farah',
  'Hiba', 'Ruba', 'Anaya', 'Inaya', 'Mahnoor', 'Laiba', 'Kinza', 'Bushra', 'Aqsa',
  'Haris Khan', 'Zain Malik', 'Noor Ahmed', 'Omar Ali', 'Rayyan Sheikh', 'Ayaan Hussain', 'Ali Raza',
  'Sara Noor', 'Layla Khan', 'Maryam Ali', 'Fatima Ahmed', 'Zara Malik',
  'Nova Smith', 'Alex Brown', 'Kai Johnson', 'Luna Williams', 'Orion Davis', 'Atlas Wilson',
  'Neo Taylor', 'Echo Walker', 'Pixel Green', 'Cipher Scott', 'Rex Morgan', 'Blaze Carter',
  'Storm Parker', 'Ghost Reed', 'Apollo King', 'Zenith Hall', 'Quantum Brooks', 'Vortex Price',
  'Phoenix Bennett', 'Hunter Ross', 'Rocket Lewis', 'Falcon Young', 'Maverick Gray', 'Shadow Cooper',
  'Titan Mitchell', 'Skye Collins', 'Jett Edwards', 'Aria Turner', 'Lyra Morris', 'Sage Rogers',
  'Cora Bailey', 'Ace Murphy', 'Bolt Richardson', 'Matrix Ward', 'Flux Howard', 'Nano Kelly',
  'James Smith', 'Emma Johnson', 'Oliver Brown', 'Sophia Williams', 'Liam Jones', 'Ava Taylor',
  'Noah Davies', 'Mia Wilson', 'Ethan Evans', 'Isabella Thomas', 'Lucas Roberts', 'Charlotte Walker',
  'Henry Lewis', 'Amelia Hall', 'Jack Young', 'Grace Allen', 'Oscar Scott', 'Chloe Green',
  'Mason', 'Logan', 'Elijah', 'Caleb', 'Ryan', 'Nathan', 'Connor', 'Tyler', 'Aaron', 'Jason',
  'Madison', 'Natalie', 'Victoria', 'Brooke', 'Claire', 'Jasmine', 'Leah', 'Paige', 'Rachel',
  'John Smith', 'Jane Doe', 'Michael Davis', 'Sarah Turner', 'David Cox', 'Emily Carter',
  'Amir Khan', 'Aisha Malik', 'Adam Hussain', 'Sarah Ahmed', 'Usman Sheikh', 'Hamza Iqbal',
  'Zain Abbas', 'Bilal Khan', 'Haris Malik', 'Tariq Hussain', 'Nadia Khan', 'Sana Malik',
  'Zara Khan', 'Ayan Malik', 'Noor Ahmed', 'Rayan Ali', 'Hassan Sheikh', 'Taha Ahmed',
  'Isa Ali', 'Huzaifa Ahmed', 'Adnan Malik', 'Faraz Noor', 'Shayan Hussain', 'Mahir Khan',
];

let nameCursor = Math.floor(Math.random() * HUMANOID_NAMES.length);

export function pickHumanoidName(used = new Set()) {
  const n = HUMANOID_NAMES.length;
  for (let i = 0; i < n; i++) {
    nameCursor = (nameCursor + 1) % n;
    const name = HUMANOID_NAMES[nameCursor];
    if (!used.has(name)) return name;
  }
  return `Traveler ${Math.random().toString(36).slice(2, 6)}`;
}
