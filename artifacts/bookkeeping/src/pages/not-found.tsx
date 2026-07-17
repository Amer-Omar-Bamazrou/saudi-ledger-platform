export default function NotFound() {
  return (
    <div className="flex items-center justify-center h-[80vh]">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-mono text-primary font-bold">404</h1>
        <p className="text-xl text-muted-foreground">System route unmapped.</p>
      </div>
    </div>
  );
}
