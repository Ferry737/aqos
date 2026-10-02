// Services the supervisor probes every 30 s. critical=true: trading cannot
// continue safely without it. Hostnames are the docker/k8s service names.
const services = [
  { name: 'stream-gateway', url: 'http://stream-gw:8080/healthz', critical: true },
  { name: 'model-service', url: 'http://model-svc:8080/healthz', critical: false },
  { name: 'portfolio-service', url: 'http://portfolio-svc:8080/healthz', critical: false },
  { name: 'risk-service', url: 'http://risk-svc:8080/healthz', critical: true },
  { name: 'ems-primary', url: 'http://ems:8080/healthz', critical: true },
  { name: 'ems-standby', url: 'http://ems-standby:8080/healthz', critical: false },
];
return services.map((s) => ({ json: s }));
