declare module 'nodemailer' {
  export type Transporter = {
    sendMail(message: unknown): Promise<unknown>
  }

  const nodemailer: {
    createTransport(options: unknown): Transporter
  }

  export default nodemailer
}
