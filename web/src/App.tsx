export default function App() {
  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 45%",
          borderBottom: "1px solid #ccc",
          padding: "16px",
          overflow: "auto",
        }}
      >
        <h2>Topology</h2>
        <p>a2a demo - topology zone</p>
      </div>
      <div
        style={{
          flex: "0 0 55%",
          padding: "16px",
          overflow: "auto",
        }}
      >
        <h2>Chat</h2>
        <p>a2a demo - chat zone</p>
      </div>
    </div>
  );
}
