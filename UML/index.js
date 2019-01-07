import React from 'react'
import ReactDOM from 'react-dom'

const mydiv = React.createElement('div',{id:'mydiv', title: 'div aaa'}, '这是一个 div')

ReactDOM.render(mydiv, document.getElementById('app'))